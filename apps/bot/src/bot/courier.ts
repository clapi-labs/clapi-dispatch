import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";

import {
  closeUndeliveredTrip,
  declareReturnDebt,
  deliverTrip,
  db,
  getReturnDebt,
  openReturnDebts,
  openTripCondition,
  resolveReturnDebtGroup,
  schema,
  simulatorEnabled,
} from "@dispatch/shared/db";
import { debtClosedText, isBeforePickup, matchRestaurant, parseDebtText, tripPhase, type DeliveryPlace, type ReturnDebtReason } from "@dispatch/shared";

import { isAck, parseCourierText } from "@/bot/courier-text";
import { say } from "@/bot/messaging";
import { notifyAssigned, notifyCustomerNoAnswer, notifyDelivered, notifyFinished, notifyGoing, notifyPicked, parseCourierButton, sendCourierTicket } from "@/bot/notify";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import { classifyCourierMessage } from "@/services/openai/courier";
import type { IncomingMessage } from "@/services/whatsapp/types";

export type Courier = typeof schema.couriers.$inferSelect;

/** Los últimos 10 dígitos: un motorizado guardado como "3001234567" y el
 *  wa_id "573001234567" de WhatsApp son la misma persona. */
export async function findCourier(phone: string): Promise<Courier | null> {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  const [courier] = await db
    .select()
    .from(schema.couriers)
    .where(and(eq(schema.couriers.active, true), sql`right(regexp_replace(${schema.couriers.phone}, '\\D', '', 'g'), 10) = ${last10}`))
    .limit(1);
  return courier ?? null;
}

/** Lo que el motorizado tiene encima, el más reciente primero, con su fase. */
async function activeTrips(courierId: number) {
  const rows = await db
    .select({ trip: schema.trips, assignment: schema.assignments })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.assignments.courierId, courierId), openTripCondition()))
    .orderBy(desc(schema.assignments.assignedAt));
  return rows.map((r) => ({ ...r, phase: tripPhase({ ...r.assignment, status: r.trip.status }) }));
}

/** Guarda la hora solo la primera vez y solo si el viaje sigue a su nombre. */
async function mark(courierId: number, tripId: number, step: "going" | "picked") {
  const column = step === "going" ? schema.assignments.seenAt : schema.assignments.pickedUpAt;
  const [row] = await db
    .update(schema.assignments)
    .set(step === "going" ? { seenAt: new Date() } : { pickedUpAt: new Date() })
    .where(and(eq(schema.assignments.tripId, tripId), eq(schema.assignments.courierId, courierId), isNull(column), isNull(schema.assignments.deliveredAt)))
    .returning({ tripId: schema.assignments.tripId });
  return Boolean(row);
}

/** Un botón viejo puede ser de un viaje que le pasaron a otra moto o se canceló. */
async function isMine(courierId: number, tripId: number) {
  const [row] = await db
    .select({ tripId: schema.assignments.tripId })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.assignments.tripId, tripId), eq(schema.assignments.courierId, courierId), ne(schema.trips.status, "cancelled")))
    .limit(1);
  return Boolean(row);
}

async function markPicked(courierId: number, tripId: number) {
  if (await mark(courierId, tripId, "picked")) await notifyPicked(tripId);
}

type TripRow = typeof schema.trips.$inferSelect;

/**
 * Declara un pendiente de regreso con ese pedido (docs/FLUJO-DOMICILIARIO.md,
 * «Pendientes de regreso»). Si todavía no había recogido, cuenta como «Recogí» y
 * le llega el mensaje 2. Si ya lo había recogido (lo marcó el GPS, o tocó
 * «Recogí» antes), se le confirma; si el pedido ya se entregó, se le dice de una
 * vez cómo cerrarlo.
 */
async function declareDebt(courier: Courier, conversation: Conversation, phone: string, trip: TripRow, reason: ReturnDebtReason, { byText = false } = {}) {
  const { created } = await declareReturnDebt({
    courierId: courier.id,
    reason,
    restaurantName: trip.originRestaurantName,
    restaurantId: trip.restaurantId,
    tripId: trip.id,
    declaredBy: "courier",
  });
  if (await mark(courier.id, trip.id, "picked")) {
    await notifyPicked(trip.id);
    return;
  }
  if (!created) {
    // Un doble toque no tiene respuesta; si lo escribió, se le confirma que ya estaba.
    if (byText) await say(conversation.id, phone, reason === "datafono" ? `Ya estaba anotado 👍 El datáfono de ${trip.originRestaurantName} sigue pendiente.` : `Ya estaba anotado 👍 Lo que le debes a ${trip.originRestaurantName} sigue pendiente.`, { tripId: trip.id });
    return;
  }
  if (trip.status === "delivered") {
    await notifyFinished(trip.id, [], "terminado");
    return;
  }
  const what = reason === "datafono" ? "que llevas el datáfono" : "que le quedaste debiendo";
  await say(conversation.id, phone, `Anotado 👍 Quedó registrado ${what} de ${trip.originRestaurantName}. Al entregar te recuerdo.`, { tripId: trip.id });
}

/** Lo que tiene a su nombre y puede tener un pendiente: lo abierto y lo
 *  entregado en las últimas 12 horas, el más reciente primero. */
async function recentTrips(courierId: number) {
  return db
    .select({ trip: schema.trips, assignment: schema.assignments })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(
      and(
        eq(schema.assignments.courierId, courierId),
        ne(schema.trips.status, "cancelled"),
        ne(schema.trips.status, "pending"),
        gt(schema.assignments.assignedAt, new Date(Date.now() - 12 * 60 * 60_000)),
      ),
    )
    .orderBy(desc(schema.assignments.assignedAt));
}

/**
 * «Recogí, llevo datáfono», «quedé debiendo en Donde Lucho», «ya devolví el
 * datáfono», «ya le pagué a Donde Lucho». El restaurante sale del nombre que
 * escribió o, si no dijo ninguno, de que todo lo que lleva sea de uno solo.
 * Con varios posibles no se adivina: se le pregunta cuál. `false` si el mensaje
 * no era sobre un pendiente.
 */
async function handleDebtText(courier: Courier, conversation: Conversation, phone: string, text: string): Promise<boolean> {
  const said = parseDebtText(text);
  if (!said) return false;

  if (said.kind === "close") {
    const open = (await openReturnDebts(courier.id)).filter((d) => d.reason === said.reason);
    const places = [...new Map(open.map((d) => [d.restaurantId ?? d.restaurantName.toLowerCase(), { name: d.restaurantName, debt: d }])).values()];
    const pick = said.restaurant ? matchRestaurant(said.restaurant, places) : places.length === 1 ? places[0] : null;
    if (!pick) {
      if (!places.length) await say(conversation.id, phone, said.reason === "datafono" ? "No tienes datáfonos anotados por devolver 👍" : "No tienes nada anotado por pagar 👍");
      else await say(conversation.id, phone, `¿En cuál? Escríbeme por ejemplo «${said.reason === "datafono" ? "devolví el datáfono en" : "le pagué a"} ${places[0].name}».`);
      return true;
    }
    const closed = await resolveReturnDebtGroup(pick.debt.id, { kind: "courier" });
    if (closed.length) await say(conversation.id, phone, debtClosedText(said.reason, pick.name));
    else await say(conversation.id, phone, "Ese datáfono todavía va con un pedido sin entregar: al entregarlo te digo cómo cerrarlo.");
    return true;
  }

  const rows = await recentTrips(courier.id);
  const candidates = rows.map((r) => ({ name: r.trip.originRestaurantName, trip: r.trip, open: r.trip.status === "assigned" || r.trip.status === "en_route" }));
  let target: (typeof candidates)[number] | null = null;
  if (said.restaurant) {
    // De ese restaurante, el más reciente (la lista va así).
    const named = matchRestaurant(said.restaurant, candidates);
    target = named ? (candidates.find((c) => c.name === named.name) ?? named) : null;
  } else {
    const open = candidates.filter((c) => c.open);
    const pool = open.length ? open : candidates.slice(0, 1);
    if (new Set(pool.map((c) => c.name.toLowerCase())).size === 1) target = pool[0];
  }
  if (!target) {
    const names = [...new Set(candidates.map((c) => c.name))];
    const how = said.reason === "datafono" ? "llevo datáfono de" : "quedé debiendo en";
    await say(conversation.id, phone, names.length ? `¿De cuál restaurante? Escríbeme por ejemplo «${how} ${names[0]}».` : "No encuentro un pedido tuyo de hoy para anotarlo. Escríbele a la central 🙏");
    return true;
  }
  await declareDebt(courier, conversation, phone, target.trip, said.reason, { byText: true });
  return true;
}

async function markDelivered(tripId: number, place: DeliveryPlace) {
  const result = await deliverTrip(tripId, { place });
  if (!result) return; // doble toque, o la central ya lo marcó
  await notifyDelivered(tripId, result.newlyAssigned);
  // La moto que se liberó puede haber tomado un pendiente en el acto.
  for (const id of result.newlyAssigned) await notifyAssigned(id);
}

/** Empieza la espera al cliente. Sin el pedido en la mano no hay a quién esperar. */
async function markNoAnswer(courierId: number, tripId: number) {
  const [row] = await db
    .update(schema.assignments)
    .set({ customerWaitAt: new Date() })
    .where(and(eq(schema.assignments.tripId, tripId), eq(schema.assignments.courierId, courierId), isNull(schema.assignments.customerWaitAt), isNull(schema.assignments.deliveredAt)))
    .returning({ tripId: schema.assignments.tripId });
  if (row) await notifyCustomerNoAnswer(tripId);
}

async function markReturned(tripId: number) {
  if (await closeUndeliveredTrip(tripId)) await notifyFinished(tripId, [], "devuelto");
}

/**
 * Lo normal es que el motorizado no escriba: recibe el mensaje y toca «Voy en
 * camino», «Recogí» y la entrega (docs/FLUJO-DOMICILIARIO.md). Por eso un mensaje
 * suyo solo se responde cuando hace falta:
 *
 * - Novedad (accidente, no puede ir, el cliente no baja…): queda en pausa
 *   (no se le asigna nada más, conserva lo que lleva) y su chat pasa a la
 *   central, que decide qué hacer (docs/INTERVENCION-MANUAL.md).
 * - Pide la ficha: se le reenvía la de la fase en que va.
 * - «Ok», «voy» con un pedido sin confirmar: cuenta como «Voy en camino».
 * - «Ya recogí», «lo dejé en portería», «el cliente no contesta»: lo mismo que
 *   el botón, si solo hay un pedido al que le aplique.
 * - «Llevo datáfono», «quedé debiendo en X», «ya devolví el datáfono», «ya le
 *   pagué a X»: declara o cierra un pendiente de regreso.
 */
export async function handleCourier(courier: Courier, conversation: Conversation, message: IncomingMessage) {
  const button = message.kind === "button" ? parseCourierButton(message.buttonId) : null;
  if (button?.kind === "debt_done") {
    const debt = await getReturnDebt(button.debtId);
    if (!debt || debt.courierId !== courier.id) return;
    // Ya estaba cerrado (otro toque, o lo cerró la central): no hay nada que decir.
    if (debt.resolvedAt) return;
    const closed = await resolveReturnDebtGroup(debt.id, { kind: "courier" });
    if (closed.length) await say(conversation.id, message.phone, debtClosedText(debt.reason, debt.restaurantName), { tripId: debt.tripId });
    return;
  }
  // «Ya volví» de antes de los pendientes: el servicio ya terminó al entregar.
  if (button?.kind === "back") return;
  if (button) {
    if (!(await isMine(courier.id, button.tripId))) {
      await say(conversation.id, message.phone, "Ese servicio ya no está a tu nombre 🙏", { tripId: button.tripId });
      return;
    }
    if (button.kind === "going") {
      if (await mark(courier.id, button.tripId, "going")) await notifyGoing(button.tripId, { old: button.old });
    } else if (button.kind === "picked") {
      if (button.debt) {
        const [trip] = await db.select().from(schema.trips).where(eq(schema.trips.id, button.tripId)).limit(1);
        if (trip) await declareDebt(courier, conversation, message.phone, trip, button.debt);
      } else {
        await markPicked(courier.id, button.tripId);
      }
    } else if (button.kind === "delivered") {
      await markDelivered(button.tripId, button.place);
    } else if (button.kind === "no_answer") {
      await markNoAnswer(courier.id, button.tripId);
    } else if (button.kind === "returned") {
      await markReturned(button.tripId);
    }
    return;
  }

  // Con la central al frente de su chat, el bot no se mete.
  if (conversation.botPaused) return;

  const trips = await activeTrips(courier.id);

  // Un «ok» o «voy» con un pedido sin confirmar es «Voy en camino»: así lo
  // hacen hoy muchos. Con varios sin confirmar, el más viejo primero.
  const unseen = trips.filter((t) => t.phase === "unread" || t.phase === "read");
  if (message.kind === "text" && unseen.length && isAck(message.text)) {
    const oldest = unseen[unseen.length - 1].trip.id;
    if (await mark(courier.id, oldest, "going")) await notifyGoing(oldest);
    return;
  }

  // Un pendiente de regreso, por texto: en cualquier momento, también después
  // de entregar.
  if (message.kind === "text" && (await handleDebtText(courier, conversation, message.phone, message.text))) return;

  const written = message.kind === "text" ? parseCourierText(message.text) : null;
  if (written) {
    const applies = trips.filter((t) => {
      if (written.kind === "returned") return t.phase === "undelivered";
      if (written.kind === "picked") return isBeforePickup(t.phase);
      if (written.kind === "no_answer") return t.phase === "carrying" || t.phase === "at_delivery";
      return t.phase !== "undelivered";
    });
    // Con varios no se adivina cuál es: que la central lo vea en su chat.
    if (applies.length === 1) {
      const tripId = applies[0].trip.id;
      if (written.kind === "picked") await markPicked(courier.id, tripId);
      else if (written.kind === "returned") await markReturned(tripId);
      else if (written.kind === "no_answer") await markNoAnswer(courier.id, tripId);
      else await markDelivered(tripId, written.place);
      return;
    }
  }

  const intent = message.kind === "text" ? await classifyCourierMessage(message.text) : { kind: "otro" as const, summary: null };

  if (intent.kind === "novedad") {
    const codes = trips.map((t) => t.trip.code).join(", ");
    const reason = `Novedad de ${courier.name}${codes ? ` (${codes})` : ""}: ${intent.summary ?? "revisar su chat"}`;
    await db.update(schema.couriers).set({ status: "paused" }).where(eq(schema.couriers.id, courier.id));
    await updateConversation(conversation.id, { botPaused: true, escalationReason: reason });
    await say(conversation.id, message.phone, "Recibido 🙏 La central ya te contacta.", { tripId: trips[0]?.trip.id ?? null });
    return;
  }

  if (intent.kind === "ficha" && trips.length) {
    for (const { trip, assignment } of trips) await sendCourierTicket(message.phone, trip, courier.name, assignment);
    return;
  }

  // Simulador: un número de prueba no recibe pedidos propios, controla motos
  // simuladas. Se le dice, para que sepa qué esperar.
  const testNumber = simulatorEnabled() && !courier.simulated;

  // Sin viajes y desconectado: escribir es conectarse. En pausa no: esa la
  // pone y la quita la central.
  if (!trips.length && courier.status === "offline") {
    await db.update(schema.couriers).set({ status: "available" }).where(eq(schema.couriers.id, courier.id));
    const first = courier.name.split(" ")[0];
    await say(
      conversation.id,
      message.phone,
      testNumber
        ? `🧪 ${first}, quedaste conectado como número de prueba del simulador. Te llega el próximo pedido que reciba una moto simulada 🛵`
        : `👋 ${first}, quedaste conectado. Te escribo apenas tengas un servicio 🛵`,
    );
    return;
  }
  if (testNumber && !trips.length && message.kind === "text") {
    await say(conversation.id, message.phone, "🧪 Estás libre como número de prueba: te llega el próximo pedido que reciba una moto simulada.");
  }
}
