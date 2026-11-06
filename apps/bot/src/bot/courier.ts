import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import { closeUndeliveredTrip, deliverTrip, db, finishTrip, openTripCondition, schema } from "@dispatch/shared/db";
import { isBeforePickup, tripPhase, type DeliveryPlace } from "@dispatch/shared";

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

/** «Ok», «voy», «ya lo vi», «recibido», 👍: un acuse corto, sin nada más. */
const ACK = /^(ok[aiy]?|okey|listo|visto|ya lo vi|lo vi|ya vi|voy|ya voy|vamos|va|dale|de una|recibido|enterado|copiado|en camino|voy para all[aá]|s[ií])[\s!.,👍✅🛵🙏]*$|^[\s👍✅🛵🙏]+$/iu;

export function isAck(text: string) {
  return ACK.test(text.trim());
}

const END = "[\\s!.,👍✅🛵🙏]*$";
const ALREADY = "^(?:ya\\s+)?(?:lo\\s+|el pedido\\s+)?";
const AND_BACK = "(,?\\s*(?:y\\s+)?(?:vuelvo|regreso|me devuelvo|voy de vuelta)(?:\\s+al\\s+(?:restaurante|local))?)?";

const PICKED = new RegExp(`${ALREADY}recog[ií](?:\\s+el pedido)?${END}|^(?:ya\\s+)?tengo el pedido${END}|^pedido recogido${END}`, "iu");
const AT_GATE = new RegExp(`${ALREADY}(?:(?:dej[eé]|entregu[eé]|qued[oó]|entregad[oa])(?:\\s+el pedido)?\\s+)?en\\s+(?:la\\s+)?porter[ií]a${AND_BACK}${END}`, "iu");
const DELIVERED = new RegExp(`${ALREADY}(?:entregu[eé]|entregad[oa])(?:\\s+el pedido)?${AND_BACK}${END}`, "iu");
const BACK = new RegExp(`^(?:ya\\s+)?(?:volv[ií]|regres[eé]|estoy de vuelta|llegu[eé] al (?:restaurante|local))${END}`, "iu");

const NO_ANSWER = new RegExp(`^(?:el\\s+)?cliente no (?:contesta|responde|sale|baja|abre)${END}`, "iu");
const RETURNED = new RegExp(`^(?:ya\\s+)?(?:lo\\s+)?devolv[ií](?:\\s+el pedido)?${END}`, "iu");

export type CourierText = { kind: "picked" } | { kind: "delivered"; place: DeliveryPlace; returning: boolean } | { kind: "back" } | { kind: "no_answer" } | { kind: "returned" };

/**
 * Lo que escribe en vez de tocar el botón. Solo frases cortas y claras, sin
 * pasar por el modelo: «no lo entregué» o «lo dejé en portería pero…» no
 * coinciden y siguen a la clasificación, donde pueden ser una novedad.
 */
export function parseCourierText(raw: string): CourierText | null {
  const text = raw.trim();
  if (PICKED.test(text)) return { kind: "picked" };
  if (BACK.test(text)) return { kind: "back" };
  if (NO_ANSWER.test(text)) return { kind: "no_answer" };
  if (RETURNED.test(text)) return { kind: "returned" };
  const gate = text.match(AT_GATE);
  if (gate) return { kind: "delivered", place: "gate", returning: Boolean(gate[1]) };
  const delivered = text.match(DELIVERED);
  if (delivered) return { kind: "delivered", place: "customer", returning: Boolean(delivered[1]) };
  return null;
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

async function markDelivered(tripId: number, place: DeliveryPlace, returning: boolean) {
  const result = await deliverTrip(tripId, { place, returning });
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

async function markBack(tripId: number) {
  const result = await finishTrip(tripId);
  if (!result) return;
  await notifyFinished(tripId, result.newlyAssigned);
  for (const id of result.newlyAssigned) await notifyAssigned(id);
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
 * - «Ya recogí», «lo dejé en portería», «el cliente no contesta», «ya volví»: lo
 *   mismo que el botón, si solo hay un pedido al que le aplique.
 */
export async function handleCourier(courier: Courier, conversation: Conversation, message: IncomingMessage) {
  const button = message.kind === "button" ? parseCourierButton(message.buttonId) : null;
  if (button) {
    if (!(await isMine(courier.id, button.tripId))) {
      await say(conversation.id, message.phone, "Ese servicio ya no está a tu nombre 🙏", { tripId: button.tripId });
      return;
    }
    if (button.kind === "going") {
      if (await mark(courier.id, button.tripId, "going")) await notifyGoing(button.tripId, { old: button.old });
    } else if (button.kind === "picked") {
      await markPicked(courier.id, button.tripId);
    } else if (button.kind === "delivered") {
      await markDelivered(button.tripId, button.place, button.returning);
    } else if (button.kind === "no_answer") {
      await markNoAnswer(courier.id, button.tripId);
    } else if (button.kind === "returned") {
      await markReturned(button.tripId);
    } else {
      await markBack(button.tripId);
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

  const written = message.kind === "text" ? parseCourierText(message.text) : null;
  if (written) {
    const applies = trips.filter((t) => {
      if (written.kind === "back") return t.phase === "returning";
      if (written.kind === "returned") return t.phase === "undelivered";
      if (written.kind === "picked") return isBeforePickup(t.phase);
      if (written.kind === "no_answer") return t.phase === "carrying" || t.phase === "at_delivery";
      return t.phase !== "returning" && t.phase !== "undelivered";
    });
    // Con varios no se adivina cuál es: que la central lo vea en su chat.
    if (applies.length === 1) {
      const tripId = applies[0].trip.id;
      if (written.kind === "picked") await markPicked(courier.id, tripId);
      else if (written.kind === "back") await markBack(tripId);
      else if (written.kind === "returned") await markReturned(tripId);
      else if (written.kind === "no_answer") await markNoAnswer(courier.id, tripId);
      else await markDelivered(tripId, written.place, written.returning);
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

  // Sin viajes y desconectado: escribir es conectarse. En pausa no: esa la
  // pone y la quita la central.
  if (!trips.length && courier.status === "offline") {
    await db.update(schema.couriers).set({ status: "available" }).where(eq(schema.couriers.id, courier.id));
    await say(conversation.id, message.phone, `👋 ${courier.name.split(" ")[0]}, quedaste conectado. Te escribo apenas tengas un servicio 🛵`);
  }
}
