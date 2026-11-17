import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import {
  claimControl,
  courierRoute,
  courierRouteText,
  db,
  getBotConfig,
  getDemandLevel,
  getReturnDebt,
  getServiceHours,
  hoursFor,
  listRestaurants,
  markReturnDebtsClaimed,
  markReturnDebtsClosingNotified,
  markReturnDebtsReminded,
  openGroupOf,
  openReturnDebts,
  openReturnDebtsOfTrip,
  openReturnStops,
  openTripCondition,
  recordDebtClaim,
  resolveDebtClaimsOfRestaurant,
  returnGroupDebtIds,
  routeReturnDebts,
  schema,
  type ReturnDebtView,
  type ReturnStopView,
} from "@dispatch/shared/db";
import {
  customerWaitEndsAt,
  debtClaimCourierText,
  debtClaimRestaurantText,
  debtCloseText,
  debtClosingSoonText,
  decideDebtClaim,
  goingReminderAt,
  groupDebts,
  idlePayText,
  isBeforePickup,
  joinCodes,
  matchRestaurant,
  minutesLeft,
  pickupLateAt,
  sameRestaurant,
  sameTripReturnText,
  traccarConfigMessage,
  tripPhase,
  type ClaimGroupCandidate,
  type DebtClaim,
  type PhaseInput,
} from "@dispatch/shared";

import { debtButton, deliveryButtons, goingButton, pickedButton, pickupButtons, returnedButton } from "@/bot/courier-buttons";
import { say } from "@/bot/messaging";
import { confirmedText, courierAssignedText, estimatePickup } from "@/bot/status";
import { conversationForOutbound } from "@/db/queries/conversation";
import { env } from "@/env";
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
 *
 * Si tiene que volver al restaurante (se llevó el datáfono, quedó debiendo la
 * comida) lo declara al recoger, y al entregar se le dice cómo cerrarlo
 * (pendientes de regreso, `return_debts`).
 *
 * Con dos o más paradas pendientes, regresos incluidos, cada mensaje empieza
 * con su ruta numerada (`courierSay`). Ningún mensaje sale solo para eso.
 */

type Trip = typeof schema.trips.$inferSelect;

export { deliveryButtons, parseCourierButton, pickupButtons, type CourierButton } from "@/bot/courier-buttons";

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

type SayOptions = Parameters<typeof say>[3];

/** Un mensaje al domiciliario, con su ruta arriba si tiene dos o más paradas
 *  (docs/FLUJO-DOMICILIARIO.md, «La ruta en los mensajes»). */
export async function courierSay(courierId: number | null | undefined, phone: string, text: string, opts?: SayOptions): Promise<SendResult> {
  const conversation = await conversationOf(phone);
  const route = courierId ? await courierRouteText(courierId) : null;
  return say(conversation.id, phone, route ? `${route}\n\n${text}` : text, opts);
}

/** Lo que tiene pendiente en el restaurante donde recoge este pedido. */
async function returnsAt(courierId: number, trip: Trip): Promise<ReturnStopView[]> {
  const here = { restaurantId: trip.restaurantId, restaurantName: trip.originRestaurantName };
  return ((await openReturnStops([courierId])).get(courierId) ?? []).filter((r) => sameRestaurant(r, here));
}

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
  if (trip.paymentMethod === "datafono") return `💳 El cliente paga con tarjeta${value ? `:${value}` : ""}.`;
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
export function pickupTicket(trip: Trip, courierName?: string | null, { sameTrip = null as string | null } = {}) {
  const first = firstName(courierName);
  const pickup = trip.pickupAddress ? `${trip.originRestaurantName} · ${trip.pickupAddress}` : trip.originRestaurantName;
  return paragraphs([
    `🛵 *${first ? `${first}, tienes` : "Tienes"} un nuevo pedido ${trip.code}*`,
    `*Recoge en:* ${pickup}`,
    trip.readyAt && trip.readyAt.getTime() > Date.now() ? `*Está listo a las:* ${hour(trip.readyAt)}` : null,
    trip.deliveryZone && `*Va para:* ${trip.deliveryZone}`,
    moneyLine(trip),
    trip.paymentMethod === "datafono" && "*Pide el datáfono en el restaurante.*",
    trip.notes && `*Indicaciones:* ${trip.notes}`,
    sameTrip,
    `*Ruta en Waze:* ${wazeLink(trip.pickupLocation ?? null, trip.pickupAddress ?? trip.originRestaurantName)}`,
    "Toca «Recogí» cuando tengas el pedido: ahí te mando a dónde va. Si te llevas el datáfono del restaurante o quedas debiendo la comida, toca ese botón en vez de «Recogí».",
  ]);
}

/** Mensaje 2: lo necesario para entregar, al tocar «Recogí». `byGps`: la
 *  recogida la marcó el GPS, así que no pudo tocar el botón del datáfono o de
 *  la plata: se le dice cómo declararlo. */
export function deliveryTicket(trip: Trip, { byGps = false } = {}) {
  const customer = [trip.customerName, trip.customerPhone && formatPhone(trip.customerPhone)].filter(Boolean).join(" · ");
  return paragraphs([
    `📦 *Perfecto, ahora lleva el pedido ${trip.code}*`,
    `*Entrega en:* ${trip.deliveryAddress}`,
    customer ? `*Cliente:* ${customer}` : null,
    moneyLine(trip),
    trip.notes && `*Indicaciones:* ${trip.notes}`,
    // Solo la calle: la torre y el apto («· Torre 4 apto 302») confunden la búsqueda.
    `*Ruta en Waze:* ${wazeLink(trip.deliveryLocation ?? null, addressParts(trip.deliveryAddress)[0])}`,
    byGps && "¿Te llevaste el datáfono o quedaste debiendo la comida? Escríbeme «llevo datáfono» o «quedé debiendo».",
    "Cuando lo entregues, toca «Entregado» o «En portería».",
  ]);
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
  const courierId = assignment.courierId ?? null;
  const phase = tripPhase({ ...assignment, status: trip.status });
  if (phase === "undelivered") return courierSay(courierId, phone, undeliveredText(trip), { tripId: trip.id, buttons: [returnedButton(trip.id)] });
  if (!isBeforePickup(phase)) return courierSay(courierId, phone, deliveryTicket(trip), { tripId: trip.id, buttons: deliveryButtons(trip.id, { waiting: phase === "waiting_customer" }) });
  const here = courierId ? await returnsAt(courierId, trip) : [];
  return courierSay(courierId, phone, pickupTicket(trip, courierName, { sameTrip: sameTripReturnText(here.map((r) => r.reason), trip.originRestaurantName) }), {
    tripId: trip.id,
    buttons: pickupButtons(trip.id),
  });
}

/** Moto asignada: mensaje 1 al motorizado + aviso al restaurante, citando el
 *  mensaje con que pidió ese domicilio. Si se asignó al confirmar
 *  (`atConfirmation`), el aviso es la confirmación con el tiempo; si se
 *  asignó después, el restaurante ya tiene su confirmación y solo se le
 *  dice quién va. */
export async function notifyAssigned(tripId: number, opts: { atConfirmation?: boolean } = {}) {
  const row = await loadTrip(tripId);
  if (!row?.courier || !row.assignment) return;
  // Simulador: si la moto es simulada y no tiene número, la toma el número de
  // prueba libre que lleva más tiempo esperando.
  const control = row.courier.simulated ? await claimControl(row.courier.id) : null;
  // Recoge donde quedó debiendo: paga en la misma vuelta, así que la plata
  // entra en su ruta aunque la demanda esté alta (el datáfono ya estaba).
  for (const r of await returnsAt(row.courier.id, row.trip)) if (!r.inRoute) await routeReturnDebts(r.debtIds);
  await sendCourierTicket(row.courier.phone, row.trip, row.courier.name, row.assignment);
  // Lo tomó ahora: le llega también lo que la moto ya llevaba, en la fase en que va.
  if (control?.taken) {
    const others = await db
      .select({ trip: schema.trips, assignment: schema.assignments })
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(and(eq(schema.assignments.courierId, row.courier.id), openTripCondition(), ne(schema.trips.id, tripId)))
      .orderBy(schema.assignments.assignedAt);
    for (const other of others) await sendCourierTicket(row.courier.phone, other.trip, row.courier.name, other.assignment);
  }

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

/** Tocó «Recogí» (o el GPS lo vio salir con el pedido): mensaje 2, citando el
 *  primero. Al restaurante no se le dice nada: el siguiente aviso es la entrega. */
export async function notifyPicked(tripId: number, { byGps = false } = {}) {
  const row = await loadTrip(tripId);
  if (!row?.courier) return;
  await courierSay(row.courier.id, row.courier.phone, deliveryTicket(row.trip, { byGps }), {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
    buttons: deliveryButtons(tripId),
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
  await courierSay(row.courier.id, row.courier.phone, `Listo 👍 Toca «Recogí» cuando tengas el pedido ${row.trip.code}.`, {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
    buttons: pickupButtons(tripId),
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
  const firstStops = new Map<number, { tipo: string; pedido: number } | undefined>();
  const candidates = await db
    .select({ trip: schema.trips, assignment: schema.assignments, courier: schema.couriers })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .innerJoin(schema.couriers, eq(schema.couriers.id, schema.assignments.courierId))
    .where(and(eq(schema.trips.status, "en_route"), isNull(schema.assignments.pickedUpAt)));

  const reminded: number[] = [];
  for (const { trip, assignment, courier } of candidates) {
    // Tiene otras paradas antes de esta recogida: no ir todavía no es demora.
    if (!firstStops.has(courier.id)) firstStops.set(courier.id, (await courierRoute(courier.id))[0]);
    const first = firstStops.get(courier.id);
    if (first?.tipo === "B" || first?.pedido !== trip.id) continue;

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

    await courierSay(courier.id, courier.phone, going ? goingReminderText(trip, courier.name) : pickupReminderText(trip, courier.name), {
      replyTo: await lastBotMessageAbout(trip.id, courier.phone),
      tripId: trip.id,
      buttons: going ? [goingButton(trip.id), pickedButton(trip.id)] : pickupButtons(trip.id),
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
    await courierSay(row.courier.id, row.courier.phone, undeliveredText(row.trip), {
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
  await courierSay(row.courier.id, row.courier.phone, `Listo 👍 Ya le avisamos al restaurante. Espera hasta ${config.customerWaitMinutes} minutos y, si el cliente sale, marca la entrega.`, {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
    buttons: deliveryButtons(tripId, { waiting: true }),
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
  await courierSay(courier.id, courier.phone, `📢 El pedido ${trip.code} ya no está a tu nombre, no vayas a recogerlo 🙏`, {
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
 * La entrega, sea el motorizado o la central quien la marque: el servicio
 * termina ahí. Al motorizado se le confirma y, si declaró un pendiente con este
 * pedido, se le dice cómo cerrarlo. `newlyAssigned`: los viajes que se
 * asignaron con esta entrega.
 */
export async function notifyDelivered(tripId: number, newlyAssigned: number[] = []) {
  const [row, config] = await Promise.all([loadTrip(tripId), getBotConfig()]);
  if (!row) return;

  await notifyFinished(tripId, newlyAssigned);

  // El de portería sale siempre: es el que el restaurante necesita para actuar.
  const gate = row.assignment?.deliveryPlace === "gate";
  const restaurant = gate || config.notifyRestaurantOnDelivery ? await restaurantConversation(row.trip.conversationId) : null;
  if (restaurant) {
    const at = hour(row.assignment?.deliveredAt ?? new Date());
    const text = gate ? gateText(row.trip, at) : `📦 Pedido ${row.trip.code} entregado a las ${at} ✅`;
    await say(restaurant.id, restaurant.phone, text, { replyTo: row.trip.sourceWaMessageId, tripId });
  }
}

/**
 * Terminó el servicio: se le confirma que quedó registrado, salvo que ya le
 * haya llegado otro pedido. No se le dice que quedó libre: puede llevar otro.
 * Si declaró un pendiente con este pedido, ese mensaje sale siempre: «Devuelve
 * el datáfono en …» o «Quedó anotado que le debes a …», con el botón que lo
 * cierra.
 */
export async function notifyFinished(tripId: number, newlyAssigned: number[] = [], word: "terminado" | "devuelto" = "terminado") {
  const [row, config] = await Promise.all([loadTrip(tripId), getBotConfig()]);
  if (!row?.courier) return;
  const confirm = config.confirmDeliveryToCourier && !(await gotNewTrip(row.courier.id, newlyAssigned));
  const debts = word === "terminado" ? await openReturnDebtsOfTrip(tripId) : [];
  if (!confirm && !debts.length) return;

  const replyTo = await lastBotMessageAbout(tripId, row.courier.phone);
  const done = `✅ ${row.trip.code} ${word}.`;
  if (!debts.length) {
    await courierSay(row.courier.id, row.courier.phone, done, { replyTo, tripId });
    return;
  }
  // Con demanda baja y libre, la plata no se anota y ya: que aproveche y pase
  // a pagar (entra en su ruta). Así no le llegan dos mensajes seguidos.
  const idle = (await getDemandLevel()) === "baja" && !(await hasOpenTrips(row.courier.id));
  for (const [i, debt] of debts.entries()) {
    const text = idle && debt.reason === "plata" ? await idlePayReminder(debt) : await debtReminder(debt);
    if (!text) continue;
    await courierSay(row.courier.id, row.courier.phone, i === 0 && confirm ? `${done}\n\n${text.text}` : text.text, { replyTo, tripId, buttons: [debtButton(debt.id, debt.reason)] });
    await markReturnDebtsReminded(text.ids);
  }
}

async function hasOpenTrips(courierId: number) {
  const [row] = await db
    .select({ id: schema.trips.id })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.assignments.courierId, courierId), openTripCondition()))
    .limit(1);
  return Boolean(row);
}

/** «Aprovecha: pasa por X a pagar»: la plata de ese grupo entra en su ruta.
 *  `null` si ya estaba (otro tick se adelantó) o ya no hay nada abierto. */
async function idlePayReminder(debt: ReturnDebtView) {
  const group = await openGroupOf(debt);
  if (!group) return null;
  const routed = await routeReturnDebts(group.debts.map((d) => d.id));
  if (!routed.length) return null;
  return { text: idlePayText(group.restaurantName, joinCodes(group.debts.map((d) => d.tripCode))), ids: group.debts.map((d) => d.id) };
}


/**
 * Lo corre el tick. Con demanda baja, al domiciliario que quedó libre y debe
 * plata se le dice una vez «Aprovecha: pasa por X a pagar», y la parada entra
 * en su ruta: si mientras va le asignan un pedido, no se pierde. Con demanda
 * alta la plata nunca genera un regreso. Devuelve los pendientes que avisó.
 */
export async function nudgeIdlePayments(): Promise<number[]> {
  if ((await getDemandLevel()) !== "baja") return [];
  const idle = await db
    .select({ id: schema.couriers.id, phone: schema.couriers.phone })
    .from(schema.couriers)
    .where(and(eq(schema.couriers.active, true), eq(schema.couriers.status, "available")));
  if (!idle.length) return [];
  const stops = await openReturnStops(idle.map((c) => c.id));
  const nudged: number[] = [];
  for (const courier of idle) {
    for (const stop of (stops.get(courier.id) ?? []).filter((r) => r.reason === "plata" && !r.inRoute)) {
      if (await hasOpenTrips(courier.id)) break;
      const debt = await getReturnDebt(stop.id);
      const text = debt && (await idlePayReminder(debt));
      if (!debt || !text) continue;
      await courierSay(courier.id, courier.phone, text.text, { tripId: debt.tripId, buttons: [debtButton(debt.id, debt.reason)] });
      await markReturnDebtsReminded(text.ids);
      nudged.push(...text.ids);
    }
  }
  return nudged;
}

/** Lo que se le dice para cerrar el grupo de un pendiente: los de ese
 *  restaurante y motivo que ya puede cerrar (un datáfono, solo si su pedido ya
 *  se entregó). `null` si no queda ninguno abierto. */
async function debtReminder(debt: ReturnDebtView, { nudge = false } = {}) {
  const group = await openGroupOf(debt);
  if (!group) return null;
  const ready = group.debts.filter((d) => d.reason === "plata" || d.deliveredAt !== null || d.tripId === null);
  const items = ready.length ? ready : group.debts;
  return { text: debtCloseText(group.reason, group.restaurantName, items.map((d) => d.tripCode), { nudge }), ids: items.map((d) => d.id) };
}

/**
 * «Mandar ya» desde el portal: le escribe al domiciliario que pase por el
 * restaurante a devolver el datáfono o a pagar, con el botón que lo cierra.
 * `false` si el pendiente ya no está abierto.
 */
export async function notifyDebtNudge(debtId: number): Promise<boolean> {
  const debt = await getReturnDebt(debtId);
  if (!debt || debt.resolvedAt) return false;
  const reminder = await debtReminder(debt, { nudge: true });
  if (!reminder) return false;
  // La central pidió que vaya: la plata entra en su ruta.
  if (debt.reason === "plata") await routeReturnDebts(await returnGroupDebtIds(debt.id));
  await courierSay(debt.courierId, debt.courierPhone, reminder.text, { tripId: debt.tripId, buttons: [debtButton(debt.id, debt.reason)] });
  await markReturnDebtsReminded(reminder.ids);
  await resolveDebtClaimsOfRestaurant({ restaurantId: debt.restaurantId, restaurantName: debt.restaurantName });
  return true;
}

/**
 * Cuando un restaurante reclama su plata o su datáfono, o avisa que ya va a
 * cerrar (#61):
 * - Caso claro (un solo domiciliario tiene un pendiente que coincide, está
 *   conectado, no se le había avisado ya por un reclamo y puede ir): le escribe
 *   al domiciliario, mete el regreso en su ruta y le responde al restaurante
 *   «Ya le avisamos a X, va para allá 🛵».
 * - Cualquier otro caso: registra el reclamo para la central y le responde al
 *   restaurante «La central ya lo está gestionando 🙏».
 */
export async function handleRestaurantDebtClaim(
  input: {
    conversationId: number;
    phone: string;
    restaurantId: number | null;
    restaurantName: string;
    claim: DebtClaim;
    replyTo?: string | null;
  },
  now = new Date(),
) {
  const [allDebts, demand] = await Promise.all([openReturnDebts(), getDemandLevel()]);
  const debts = allDebts.filter((d) => sameRestaurant(input, d));
  const groups = groupDebts(debts);
  const courierIds = [...new Set(groups.map((g) => g.courierId))];
  const couriers = courierIds.length
    ? await db.select().from(schema.couriers).where(inArray(schema.couriers.id, courierIds))
    : [];
  const byCourier = new Map(couriers.map((c) => [c.id, c]));
  const busyByCourier = new Map<number, boolean>();
  for (const id of courierIds) busyByCourier.set(id, await hasOpenTrips(id));

  const candidates: ClaimGroupCandidate[] = groups.map((g) => {
    const c = byCourier.get(g.courierId);
    return {
      courierId: g.courierId,
      courierName: g.debts[0].courierName,
      reason: g.reason,
      since: g.since,
      claimedAt: g.debts.map((d) => d.claimedAt).find((at) => at !== null) ?? null,
      connected: Boolean(c?.active && c.status !== "offline"),
      busy: busyByCourier.get(g.courierId) ?? false,
    };
  });

  const decision = decideDebtClaim(input.claim, candidates, demand);
  if (decision.kind === "auto") {
    const targetGroups = groups.filter(
      (g) => g.courierId === decision.courierId && (!input.claim.reason || g.reason === input.claim.reason),
    );
    for (const g of targetGroups) {
      const ids = g.debts.map((d) => d.id);
      if (g.reason === "plata") await routeReturnDebts(ids);
      await markReturnDebtsClaimed(ids, now);
      const text = debtClaimCourierText(
        g.reason,
        g.restaurantName,
        g.debts.map((d) => d.tripCode),
        { closing: input.claim.closing, busy: decision.busy },
      );
      await courierSay(g.courierId, g.debts[0].courierPhone, text, {
        tripId: g.debts[0].tripId,
        buttons: [debtButton(g.debts[0].id, g.reason)],
      });
    }
    await say(input.conversationId, input.phone, debtClaimRestaurantText(decision), {
      replyTo: input.replyTo ?? undefined,
    });
    return decision;
  }

  await recordDebtClaim(
    {
      restaurantId: input.restaurantId,
      restaurantName: input.restaurantName,
      conversationId: input.conversationId,
      reason: input.claim.reason,
      closing: input.claim.closing,
      why: decision.why,
    },
    now,
  );
  await say(input.conversationId, input.phone, debtClaimRestaurantText(decision), {
    replyTo: input.replyTo ?? undefined,
  });
  return decision;
}

/**
 * Lo corre el tick: unos minutos antes de la hora límite de cada restaurante
 * (`closingDebtMinutes`), avisa a quien tenga un pendiente con ese restaurante
 * («⏰ X cierra pronto: pasa a devolver el datáfono / a pagar») con las mismas
 * reglas del caso claro (#61).
 */
export async function remindClosingDebts(now = new Date()): Promise<number[]> {
  const [debts, config, hours, restaurants, demand] = await Promise.all([
    openReturnDebts(),
    getBotConfig(),
    getServiceHours(),
    listRestaurants(),
    getDemandLevel(),
  ]);
  if (!debts.length) return [];

  const groups = groupDebts(debts);
  const courierIds = [...new Set(groups.map((g) => g.courierId))];
  const couriers = await db.select().from(schema.couriers).where(inArray(schema.couriers.id, courierIds));
  const byCourier = new Map(couriers.map((c) => [c.id, c]));
  const byRestId = new Map(restaurants.map((r) => [r.id, r]));

  const notified: number[] = [];
  for (const g of groups) {
    if (g.debts.some((d) => d.closingNotifiedAt !== null || d.claimedAt !== null)) continue;
    const r = (g.restaurantId ? byRestId.get(g.restaurantId) : null) ?? matchRestaurant(g.restaurantName, restaurants);
    const restHours = hoursFor(r ?? null, hours);
    const left = minutesLeft(now, restHours);
    if (left === null || left > config.closingDebtMinutes) continue;

    // Mismas reglas del caso claro para ese restaurante y motivo (con closing = true).
    const peerGroups = groups.filter((p) => p.reason === g.reason && sameRestaurant(g, p));
    const candidates: ClaimGroupCandidate[] = [];
    for (const p of peerGroups) {
      const c = byCourier.get(p.courierId);
      candidates.push({
        courierId: p.courierId,
        courierName: p.debts[0].courierName,
        reason: p.reason,
        since: p.since,
        claimedAt: p.debts.map((d) => d.claimedAt ?? d.closingNotifiedAt).find((at) => at !== null) ?? null,
        connected: Boolean(c?.active && c.status !== "offline"),
        busy: await hasOpenTrips(p.courierId),
      });
    }
    const decision = decideDebtClaim({ reason: g.reason, closing: true }, candidates, demand);
    if (decision.kind !== "auto" || decision.courierId !== g.courierId) continue;

    const ids = g.debts.map((d) => d.id);
    const claimedIds = await markReturnDebtsClosingNotified(ids, now);
    if (!claimedIds.length) continue;
    if (g.reason === "plata") await routeReturnDebts(ids);
    const text = debtClosingSoonText(
      g.reason,
      g.restaurantName,
      g.debts.map((d) => d.tripCode),
      { busy: decision.busy },
    );
    await courierSay(g.courierId, g.debts[0].courierPhone, text, {
      tripId: g.debts[0].tripId,
      buttons: [debtButton(g.debts[0].id, g.reason)],
    });
    notified.push(...claimedIds);
  }
  return notified;
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
  await courierSay(row.courier.id, row.courier.phone, `📢 ${row.trip.code}: ${change}`, {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
  });
}

const WA_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Envía al domiciliario la configuración de Traccar Client por WhatsApp (#53):
 * identificador, URL del servidor y ajustes en líneas separadas.
 * WhatsApp solo deja escribir a quien nos escribió en las últimas 24 horas: si
 * no lo ha hecho, devuelve `outside_window` para que el portal lo avise.
 */
export async function notifyCourierGpsConfig(
  courierId: number,
  gpsUrl?: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "no_gps_id" | "no_url" | "outside_window" | "send_failed" }> {
  const [row] = await db
    .select({ courier: schema.couriers, gpsDeviceId: schema.courierProfiles.gpsDeviceId })
    .from(schema.couriers)
    .leftJoin(schema.courierProfiles, eq(schema.courierProfiles.courierId, schema.couriers.id))
    .where(eq(schema.couriers.id, courierId))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  if (!row.gpsDeviceId) return { ok: false, reason: "no_gps_id" };

  const serverUrl = gpsUrl?.trim() || (env.botHost ? `https://${env.botHost}/api/gps` : "");
  if (!serverUrl) return { ok: false, reason: "no_url" };

  const conversation = await conversationOf(row.courier.phone);
  const inWindow = conversation.lastInboundAt !== null && Date.now() - conversation.lastInboundAt.getTime() < WA_WINDOW_MS;
  if (!env.whatsappSimulated && !inWindow) return { ok: false, reason: "outside_window" };

  const res = await say(conversation.id, row.courier.phone, traccarConfigMessage(row.gpsDeviceId, serverUrl));
  if (res.ok) return { ok: true };
  if (res.reason === "http_error") {
    const code = (res.body as { error?: { code?: number } } | null)?.error?.code;
    if (code === 131047) return { ok: false, reason: "outside_window" };
  }
  return { ok: false, reason: "send_failed" };
}
