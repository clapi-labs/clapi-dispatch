import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db, getBotConfig, getEngineConfig, openTripCondition, schema } from "@dispatch/shared/db";
import {
  customerWaitEndsAt,
  goingReminderAt,
  isBeforePickup,
  orderStops,
  pickupLateAt,
  stopsForPhase,
  tripPhase,
  type DeliveryPlace,
  type PhaseInput,
  type RouteStop,
} from "@dispatch/shared";

import { say } from "@/bot/messaging";
import { confirmedText, courierAssignedText, estimatePickup } from "@/bot/status";
import { conversationForOutbound } from "@/db/queries/conversation";
import type { SendResult } from "@/services/whatsapp/client";

/**
 * Los avisos que salen cuando un viaje cambia de manos. Viven en el bot (el
 * único que habla con Meta) y los dispara quien cambie el estado: el bot
 * mismo al cerrar un pedido, o el portal por `/api/internal/notify`.
 *
 * Al motorizado se le da la información por partes (docs/FLUJO-DOMICILIARIO.md):
 * primero solo lo necesario para ir a recoger y, al tocar «Recogí», lo necesario
 * para entregar. Tocar un botón no se cobra y el toque queda en su chat, así que
 * solo se le responde cuando hay algo nuevo que decirle.
 */

type Trip = typeof schema.trips.$inferSelect;

const GOING_PREFIX = "going:";
const PICKED_PREFIX = "picked:";
const DONE_PREFIX = "done:";
const BACK_PREFIX = "back:";
const NO_ANSWER_PREFIX = "noanswer:";
const RETURNED_PREFIX = "returned:";
/** Los botones de la ficha anterior: los ya enviados tienen que seguir sirviendo. */
const OLD_SEEN_PREFIX = "seen:";
const OLD_DELIVER_PREFIX = "deliver:";

export type CourierButton =
  | { kind: "going"; tripId: number; old: boolean }
  | { kind: "picked"; tripId: number }
  | { kind: "delivered"; tripId: number; place: DeliveryPlace; returning: boolean }
  | { kind: "back"; tripId: number }
  | { kind: "no_answer"; tripId: number }
  | { kind: "returned"; tripId: number };

/** Qué tocó el motorizado; `null` si el botón no es de su flujo. */
export function parseCourierButton(id: string): CourierButton | null {
  const after = (prefix: string) => Number(id.slice(prefix.length));
  if (id.startsWith(GOING_PREFIX)) return { kind: "going", tripId: after(GOING_PREFIX), old: false };
  if (id.startsWith(OLD_SEEN_PREFIX)) return { kind: "going", tripId: after(OLD_SEEN_PREFIX), old: true };
  if (id.startsWith(PICKED_PREFIX)) return { kind: "picked", tripId: after(PICKED_PREFIX) };
  if (id.startsWith(BACK_PREFIX)) return { kind: "back", tripId: after(BACK_PREFIX) };
  if (id.startsWith(NO_ANSWER_PREFIX)) return { kind: "no_answer", tripId: after(NO_ANSWER_PREFIX) };
  if (id.startsWith(RETURNED_PREFIX)) return { kind: "returned", tripId: after(RETURNED_PREFIX) };
  if (id.startsWith(OLD_DELIVER_PREFIX)) return { kind: "delivered", tripId: after(OLD_DELIVER_PREFIX), place: "customer", returning: false };
  if (id.startsWith(DONE_PREFIX)) {
    const [place, next, tripId] = id.slice(DONE_PREFIX.length).split(":");
    return { kind: "delivered", tripId: Number(tripId), place: place === "gate" ? "gate" : "customer", returning: next === "return" };
  }
  return null;
}

const goingButton = (tripId: number) => ({ id: `${GOING_PREFIX}${tripId}`, title: "🛵 Voy en camino" });
const pickedButton = (tripId: number) => ({ id: `${PICKED_PREFIX}${tripId}`, title: "📦 Recogí" });
const backButton = (tripId: number) => ({ id: `${BACK_PREFIX}${tripId}`, title: "Ya volví" });
const returnedButton = (tripId: number) => ({ id: `${RETURNED_PREFIX}${tripId}`, title: "Devolví el pedido" });

/** Las 4 opciones no caben en botones (WhatsApp permite 3): van en una lista. */
const deliveryList = (tripId: number, { waiting = false } = {}) => ({
  button: "Marcar entrega",
  rows: [
    { id: `${DONE_PREFIX}customer:finish:${tripId}`, title: "Entregado, terminé" },
    { id: `${DONE_PREFIX}customer:return:${tripId}`, title: "Entregado, vuelvo" },
    { id: `${DONE_PREFIX}gate:finish:${tripId}`, title: "En portería, terminé" },
    { id: `${DONE_PREFIX}gate:return:${tripId}`, title: "En portería, vuelvo" },
    ...(waiting ? [] : [{ id: `${NO_ANSWER_PREFIX}${tripId}`, title: "Cliente no contesta" }]),
  ],
});

function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] || null;
}

function cop(n: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

function hour(date: Date) {
  return date.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });
}

async function loadTrip(tripId: number) {
  const [row] = await db
    .select({ trip: schema.trips, assignment: schema.assignments, courier: schema.couriers })
    .from(schema.trips)
    .leftJoin(schema.assignments, eq(schema.assignments.tripId, schema.trips.id))
    .leftJoin(schema.couriers, eq(schema.couriers.id, schema.assignments.courierId))
    .where(eq(schema.trips.id, tripId));
  return row ?? null;
}

/** El hilo del motorizado; se crea si nunca ha escrito, para que su ficha
 *  quede guardada y los avisos posteriores la puedan citar. */
const conversationOf = conversationForOutbound;

async function restaurantConversation(conversationId: number | null) {
  if (!conversationId) return null;
  const [c] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  return c ?? null;
}

function formatPhone(phone: string) {
  const d = phone.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : phone;
}

/** El cobro es entre el restaurante, el cliente y el motorizado: la agencia
 *  no lo exige ni lo liquida. Si el restaurante lo dijo, va informativo. */
function moneyLine(trip: Trip) {
  if (trip.paymentMethod === "transferencia") return "Ya está pagado, no cobres.";
  const value = trip.valueToCollect ? ` ${cop(trip.valueToCollect)}` : "";
  if (trip.paymentMethod === "efectivo") return `Cobra en efectivo${value}.`;
  return value ? `Valor del pedido:${value}.` : null;
}

/** Una idea por párrafo, separados por una línea en blanco, para leerlo rápido
 *  desde la moto. */
function paragraphs(lines: (string | null | false | undefined)[]) {
  return lines.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}

function wazeLink(location: { lat: number; lng: number } | null, address: string) {
  return location ? `https://waze.com/ul?ll=${location.lat},${location.lng}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(`${address}, Cali`)}&navigate=yes`;
}

/** La calle y el apartamento, por separado. */
const addressParts = (address: string) => address.split(" · ");

/** Mensaje 1: solo para ir a recoger. El cobro va aquí porque tiene que saber
 *  antes de salir si necesita base o datáfono. */
export function pickupTicket(trip: Trip, courierName?: string | null, { going = false, routeLine = null as string | null } = {}) {
  const first = firstName(courierName);
  const pickup = trip.pickupAddress ? `${trip.originRestaurantName} · ${trip.pickupAddress}` : trip.originRestaurantName;
  return paragraphs([
    `🛵 *${first ? `${first}, tienes` : "Tienes"} un nuevo pedido ${trip.code}*`,
    `*Recoge en:* ${pickup}`,
    trip.readyAt && trip.readyAt.getTime() > Date.now() ? `*Está listo a las:* ${hour(trip.readyAt)}` : null,
    trip.deliveryZone && `*Va para:* ${trip.deliveryZone}`,
    moneyLine(trip),
    trip.notes && `*Indicaciones:* ${trip.notes}`,
    routeLine && `*Tu orden:* ${routeLine}`,
    `*Ruta en Waze:* ${wazeLink(trip.pickupLocation ?? null, trip.pickupAddress ?? trip.originRestaurantName)}`,
    `${going ? "Toca" : "Toca «Voy en camino» al salir y"} «Recogí» cuando tengas el pedido: ahí te mando a dónde va.`,
  ]);
}

/** Mensaje 2: lo necesario para entregar, al tocar «Recogí». */
export function deliveryTicket(trip: Trip) {
  const customer = [trip.customerName, trip.customerPhone && formatPhone(trip.customerPhone)].filter(Boolean).join(" · ");
  return paragraphs([
    `📦 *Perfecto, ahora lleva el pedido ${trip.code}*`,
    `*Entrega en:* ${trip.deliveryAddress}`,
    customer ? `*Cliente:* ${customer}` : null,
    moneyLine(trip),
    trip.notes && `*Indicaciones:* ${trip.notes}`,
    // Solo la calle: la torre y el apto («· Torre 4 apto 302») confunden la búsqueda.
    `*Ruta en Waze:* ${wazeLink(trip.deliveryLocation ?? null, addressParts(trip.deliveryAddress)[0])}`,
    "Cuando lo entregues, toca «Marcar entrega» y elige cómo quedó.",
  ]);
}

/** Mensaje 3: solo para quien debe volver. */
export function backText(trip: Trip) {
  return `Listo 👍 Cuando vuelvas a ${trip.originRestaurantName}, toca «Ya volví».`;
}

/** Pasó la espera y el cliente no contestó. */
export function undeliveredText(trip: Trip) {
  return `⏰ El cliente del pedido ${trip.code} no contestó. Devuélvelo a ${trip.originRestaurantName} y toca «Devolví el pedido».`;
}

/** El recordatorio a quien no ha tocado «Voy en camino». */
export function goingReminderText(trip: Pick<Trip, "code" | "originRestaurantName">, courierName: string | null) {
  const name = firstName(courierName);
  return `⏰ ${name ? `${name}, ¿ya` : "¿Ya"} vas por el pedido ${trip.code}? Recoge en ${trip.originRestaurantName}.`;
}

/** El recordatorio a quien no ha recogido y la comida ya debería estar lista. */
export function pickupReminderText(trip: Pick<Trip, "code" | "originRestaurantName">, courierName: string | null) {
  const name = firstName(courierName);
  return `⏰ ${name ? `${name}, el` : "El"} pedido ${trip.code} ya está listo en ${trip.originRestaurantName}. ¿Vas en camino?`;
}

/**
 * El mensaje de la fase en que va, con sus botones: el de asignar y el que se
 * reenvía si pide la ficha otra vez.
 */
export async function sendCourierTicket(
  phone: string,
  trip: Trip,
  courierName: string | null | undefined,
  assignment: Omit<PhaseInput, "status"> & { courierId?: number | null },
): Promise<SendResult> {
  const conversation = await conversationOf(phone);
  const phase = tripPhase({ ...assignment, status: trip.status });
  if (phase === "returning") return say(conversation.id, phone, backText(trip), { tripId: trip.id, buttons: [backButton(trip.id)] });
  if (phase === "undelivered") return say(conversation.id, phone, undeliveredText(trip), { tripId: trip.id, buttons: [returnedButton(trip.id)] });
  if (!isBeforePickup(phase)) return say(conversation.id, phone, deliveryTicket(trip), { tripId: trip.id, list: deliveryList(trip.id, { waiting: phase === "waiting_customer" }) });
  const going = phase === "going" || phase === "at_pickup";
  return say(conversation.id, phone, pickupTicket(trip, courierName, { going, routeLine: await routeLineFor(trip.id, assignment.courierId ?? null) }), {
    tripId: trip.id,
    buttons: going ? [pickedButton(trip.id)] : [goingButton(trip.id), pickedButton(trip.id)],
  });
}

/** Las paradas pendientes de la moto, en orden, con el código de cada viaje. */
async function courierStops(courierId: number): Promise<(RouteStop & { code: string })[]> {
  const [{ asumirRegreso }, [saved], rows] = await Promise.all([
    getEngineConfig(),
    db.select({ stops: schema.courierRoutes.stops }).from(schema.courierRoutes).where(eq(schema.courierRoutes.courierId, courierId)).limit(1),
    db
      .select({ trip: schema.trips, assignment: schema.assignments })
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(and(eq(schema.assignments.courierId, courierId), openTripCondition()))
      .orderBy(schema.assignments.assignedAt),
  ]);
  const codes = new Map(rows.map((r) => [r.trip.id, r.trip.code]));
  const stops = orderStops(
    saved?.stops,
    rows.map((r) => ({ id: r.trip.id, stops: stopsForPhase(tripPhase({ ...r.assignment, status: r.trip.status }), asumirRegreso) })),
  );
  return stops.map((s) => ({ ...s, code: codes.get(s.pedido) ?? "" }));
}

const STOP_VERB = { R: "Recoge", C: "Entrega", V: "Devuelve" } as const;

/** Con varios pedidos, en qué orden hacerlos: «Entrega A-07 → Recoge A-08 →
 *  Entrega A-08». El regreso no va: es el peor caso, todavía no se sabe. */
async function routeLineFor(tripId: number, courierId: number | null) {
  if (!courierId) return null;
  const stops = (await courierStops(courierId)).filter((s) => s.tipo === "R" || s.tipo === "C" || s.tipo === "V");
  if (new Set(stops.map((s) => s.pedido)).size < 2) return null;
  return stops.map((s) => `${STOP_VERB[s.tipo as keyof typeof STOP_VERB]} ${s.code}`).join(" → ");
}

/** Moto asignada: mensaje 1 al motorizado + aviso al restaurante, citando el
 *  mensaje con que pidió ese domicilio. Si se asignó al confirmar
 *  (`atConfirmation`), el aviso es la confirmación con el tiempo; si se
 *  asignó después, el restaurante ya tiene su confirmación y solo se le
 *  dice quién va. */
export async function notifyAssigned(tripId: number, opts: { atConfirmation?: boolean } = {}) {
  const row = await loadTrip(tripId);
  if (!row?.courier || !row.assignment) return;
  await sendCourierTicket(row.courier.phone, row.trip, row.courier.name, row.assignment);

  const { notifyRestaurantOnAssign } = await getBotConfig();
  const restaurant = opts.atConfirmation || notifyRestaurantOnAssign ? await restaurantConversation(row.trip.conversationId) : null;
  if (restaurant) {
    // Sin el número del domiciliario: el restaurante habla siempre con la agencia.
    const text = opts.atConfirmation
      ? confirmedText(
          row.trip.code,
          estimatePickup({ readyAt: row.trip.readyAt, pickup: row.trip.pickupLocation ?? null, courier: row.courier }),
          row.courier.name,
          cop(row.trip.deliveryFee),
        )
      : courierAssignedText(row.trip.code, row.courier.name);
    await say(restaurant.id, restaurant.phone, text, { replyTo: row.trip.sourceWaMessageId, tripId });
  }
}

/** Tocó «Recogí»: mensaje 2, citando el primero. Al restaurante no se le dice
 *  nada: el siguiente aviso es la entrega. */
export async function notifyPicked(tripId: number) {
  const row = await loadTrip(tripId);
  if (!row?.courier) return;
  const conversation = await conversationOf(row.courier.phone);
  await say(conversation.id, row.courier.phone, deliveryTicket(row.trip), {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
    list: deliveryList(tripId),
  });
}

/**
 * Tocó «Voy en camino». Lo normal es no responder, porque «Recogí» sigue en el
 * mismo mensaje. Solo se le manda aparte si la agencia lo pidió
 * (`pickupButtonAfterGoing`), o si tocó el botón de la ficha anterior, que no lo
 * tenía.
 */
export async function notifyGoing(tripId: number, opts: { old?: boolean } = {}) {
  const { pickupButtonAfterGoing } = await getBotConfig();
  if (!opts.old && !pickupButtonAfterGoing) return;
  const row = await loadTrip(tripId);
  if (!row?.courier) return;
  const conversation = await conversationOf(row.courier.phone);
  await say(conversation.id, row.courier.phone, `Listo 👍 Toca «Recogí» cuando tengas el pedido ${row.trip.code}.`, {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
    buttons: [pickedButton(tripId)],
  });
}

/**
 * Lo corre el tick. Una sola vez por asignación, a cada motorizado se le
 * recuerda «Voy en camino» y, si la comida ya debería estar en sus manos,
 * «Recogí». Las horas salen de `domain/phase`, las mismas de la alerta del
 * tablero. Cada recordatorio se reclama con un UPDATE condicional, así que dos
 * ticks a la vez no lo mandan dos veces. Devuelve los viajes recordados.
 */
export async function remindCouriers(): Promise<number[]> {
  const config = await getBotConfig();
  const now = Date.now();
  const firstStops = new Map<number, RouteStop | undefined>();
  const candidates = await db
    .select({ trip: schema.trips, assignment: schema.assignments, courier: schema.couriers })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .innerJoin(schema.couriers, eq(schema.couriers.id, schema.assignments.courierId))
    .where(and(eq(schema.trips.status, "en_route"), isNull(schema.assignments.pickedUpAt)));

  const reminded: number[] = [];
  for (const { trip, assignment, courier } of candidates) {
    // Tiene otras paradas antes de esta recogida: no ir todavía no es demora.
    if (!firstStops.has(courier.id)) firstStops.set(courier.id, (await courierStops(courier.id))[0]);
    if (firstStops.get(courier.id)?.pedido !== trip.id) continue;

    const times = { assignedAt: assignment.assignedAt, readyAt: trip.readyAt };
    const going = !assignment.seenAt && !assignment.atPickupAt && !assignment.seenReminderAt && now >= goingReminderAt(times, config).getTime();
    const pickup = !assignment.pickupReminderAt && now >= pickupLateAt(times, config).getTime();
    if (!going && !pickup) continue;

    const [claimed] = await db
      .update(schema.assignments)
      .set(going ? { seenReminderAt: new Date() } : { pickupReminderAt: new Date() })
      .where(and(eq(schema.assignments.tripId, trip.id), isNull(going ? schema.assignments.seenReminderAt : schema.assignments.pickupReminderAt)))
      .returning({ tripId: schema.assignments.tripId });
    if (!claimed) continue;

    const conversation = await conversationOf(courier.phone);
    await say(conversation.id, courier.phone, going ? goingReminderText(trip, courier.name) : pickupReminderText(trip, courier.name), {
      replyTo: await lastBotMessageAbout(trip.id, courier.phone),
      tripId: trip.id,
      buttons: assignment.seenAt ? [pickedButton(trip.id)] : [goingButton(trip.id), pickedButton(trip.id)],
    });
    reminded.push(trip.id);
  }
  return reminded;
}

/**
 * Lo corre el tick: a quien ya esperó lo que era a un cliente que no contesta se
 * le dice que devuelva el pedido, y el restaurante se entera. Se reclama con un
 * UPDATE condicional, igual que los recordatorios.
 */
export async function closeCustomerWaits(): Promise<number[]> {
  const config = await getBotConfig();
  const waiting = await db
    .select({ tripId: schema.assignments.tripId, customerWaitAt: schema.assignments.customerWaitAt })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.trips.status, "en_route"), isNotNull(schema.assignments.customerWaitAt), isNull(schema.assignments.undeliveredAt)));

  const closed: number[] = [];
  for (const { tripId, customerWaitAt } of waiting) {
    if (Date.now() < customerWaitEndsAt({ customerWaitAt }, config).getTime()) continue;
    const [claimed] = await db
      .update(schema.assignments)
      .set({ undeliveredAt: new Date() })
      .where(and(eq(schema.assignments.tripId, tripId), isNull(schema.assignments.undeliveredAt), isNull(schema.assignments.deliveredAt)))
      .returning({ tripId: schema.assignments.tripId });
    if (!claimed) continue;

    const row = await loadTrip(tripId);
    if (!row?.courier) continue;
    const conversation = await conversationOf(row.courier.phone);
    await say(conversation.id, row.courier.phone, undeliveredText(row.trip), {
      replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
      tripId,
      buttons: [returnedButton(tripId)],
    });
    const restaurant = await restaurantConversation(row.trip.conversationId);
    if (restaurant) {
      await say(restaurant.id, restaurant.phone, `⚠️ Pedido ${row.trip.code}: el cliente no contestó en ${config.customerWaitMinutes} minutos. El domiciliario te lo devuelve.`, {
        replyTo: row.trip.sourceWaMessageId,
        tripId,
      });
    }
    closed.push(tripId);
  }
  return closed;
}

/** El cliente no contesta: el motorizado espera y el restaurante, que es quien
 *  habla con el cliente, intenta contactarlo. */
export async function notifyCustomerNoAnswer(tripId: number) {
  const [row, config] = await Promise.all([loadTrip(tripId), getBotConfig()]);
  if (!row?.courier) return;
  const conversation = await conversationOf(row.courier.phone);
  await say(conversation.id, row.courier.phone, `Listo 👍 Ya le avisamos al restaurante. Espera hasta ${config.customerWaitMinutes} minutos y, si el cliente sale, marca la entrega.`, {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
    list: deliveryList(tripId, { waiting: true }),
  });
  const restaurant = await restaurantConversation(row.trip.conversationId);
  if (restaurant) {
    const who = [row.trip.customerName, row.trip.customerPhone && formatPhone(row.trip.customerPhone)].filter(Boolean).join(" · ");
    await say(
      restaurant.id,
      restaurant.phone,
      `⚠️ Pedido ${row.trip.code}: el cliente no contesta${who ? ` (${who})` : ""}. El domiciliario lo espera hasta ${config.customerWaitMinutes} minutos. ¿Puedes contactarlo?`,
      { replyTo: row.trip.sourceWaMessageId, tripId },
    );
  }
}

/** Le quitaron el pedido para dárselo a otra moto. */
export async function notifyUnassigned(tripId: number, courierId: number) {
  const [[courier], [trip]] = await Promise.all([
    db.select().from(schema.couriers).where(eq(schema.couriers.id, courierId)).limit(1),
    db.select().from(schema.trips).where(eq(schema.trips.id, tripId)).limit(1),
  ]);
  if (!courier || !trip) return;
  const conversation = await conversationOf(courier.phone);
  await say(conversation.id, courier.phone, `📢 El pedido ${trip.code} ya no está a tu nombre, no vayas a recogerlo 🙏`, {
    replyTo: await lastBotMessageAbout(tripId, courier.phone),
    tripId,
  });
}

/** Lo que el restaurante necesita para avisarle a su cliente: para quién y a
 *  qué apartamento. La agencia nunca le escribe al cliente. */
function gateText(trip: Trip, at: string) {
  const [street, unit] = addressParts(trip.deliveryAddress);
  const who = [trip.customerName, unit ?? street].filter(Boolean).join(", ");
  return `📦 Pedido ${trip.code} quedó en portería a las ${at} ✅\n\nPara ${who}. Ya puedes avisarle al cliente.`;
}

/** ¿Ya le llegó otro pedido? Entonces ese mensaje le sirve de confirmación. */
async function gotNewTrip(courierId: number, newlyAssigned: number[]) {
  if (!newlyAssigned.length) return false;
  const [row] = await db
    .select({ tripId: schema.assignments.tripId })
    .from(schema.assignments)
    .where(and(eq(schema.assignments.courierId, courierId), inArray(schema.assignments.tripId, newlyAssigned)))
    .limit(1);
  return Boolean(row);
}

/**
 * La entrega, sea el motorizado o la central quien la marque. El restaurante
 * recibe la hora real aunque el motorizado siga en camino de regreso; a este se
 * le manda «Ya volví» si debe volver y, si no, la confirmación de que terminó.
 * `newlyAssigned`: los viajes que se asignaron con esta entrega.
 */
export async function notifyDelivered(tripId: number, newlyAssigned: number[] = []) {
  const [row, config] = await Promise.all([loadTrip(tripId), getBotConfig()]);
  if (!row) return;

  const returning = row.assignment?.returnStartedAt && !row.assignment.finishedAt;
  if (row.courier && returning) {
    const conversation = await conversationOf(row.courier.phone);
    await say(conversation.id, row.courier.phone, backText(row.trip), {
      replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
      tripId,
      buttons: [backButton(tripId)],
    });
  } else {
    await notifyFinished(tripId, newlyAssigned);
  }

  // El de portería sale siempre: es el que el restaurante necesita para actuar.
  const gate = row.assignment?.deliveryPlace === "gate";
  const restaurant = gate || config.notifyRestaurantOnDelivery ? await restaurantConversation(row.trip.conversationId) : null;
  if (restaurant) {
    const at = hour(row.assignment?.deliveredAt ?? new Date());
    const text = gate ? gateText(row.trip, at) : `📦 Pedido ${row.trip.code} entregado a las ${at} ✅`;
    await say(restaurant.id, restaurant.phone, text, { replyTo: row.trip.sourceWaMessageId, tripId });
  }
}

/** Terminó el servicio: se le confirma que quedó registrado, salvo que ya le
 *  haya llegado otro pedido. No se le dice que quedó libre: puede llevar otro. */
export async function notifyFinished(tripId: number, newlyAssigned: number[] = [], word: "terminado" | "devuelto" = "terminado") {
  const [row, config] = await Promise.all([loadTrip(tripId), getBotConfig()]);
  if (!row?.courier || !config.confirmDeliveryToCourier) return;
  if (await gotNewTrip(row.courier.id, newlyAssigned)) return;
  const conversation = await conversationOf(row.courier.phone);
  await say(conversation.id, row.courier.phone, `✅ ${row.trip.code} ${word}.`, {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
  });
}

/** El último mensaje que el bot le mandó a un número sobre un viaje: para
 *  responder citándolo (la ficha del motorizado, por ejemplo). */
async function lastBotMessageAbout(tripId: number, phone: string) {
  const [row] = await db
    .select({ waMessageId: schema.messages.waMessageId })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.messages.tripId, tripId), eq(schema.messages.role, "bot"), eq(schema.conversations.phone, phone)))
    .orderBy(desc(schema.messages.id))
    .limit(1);
  return row?.waMessageId ?? null;
}

/** El restaurante cambió algo de un pedido ya asignado: se le avisa al
 *  motorizado citando su ficha. Sin moto asignada no hay a quién avisar. */
export async function notifyTripUpdated(tripId: number, change: string) {
  const row = await loadTrip(tripId);
  if (!row?.courier) return;
  const conversation = await conversationOf(row.courier.phone);
  await say(conversation.id, row.courier.phone, `📢 ${row.trip.code}: ${change}`, {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
  });
}
