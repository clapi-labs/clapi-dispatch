import { and, desc, eq, gt, inArray, or } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { estimateEtaMinutes, haversineKm, isBeforePickup, tripPhase, type TripPhase } from "@dispatch/shared";

import { say } from "@/bot/messaging";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import type { Trip } from "@/db/queries/trips";

/**
 * «¿Ya llegó el domicilio?», «¿quién va?» (caso 13 de
 * docs/CONVERSACIONES-REALES.md). Se responde con lo que dice la base: el
 * estado de cada pedido y quién lo lleva. No usa al engine ni a Google.
 *
 * De qué pedido: el que citó; si no citó, todos los abiertos y los entregados
 * de las últimas 3 horas (el «¿ya llegó?» suele ser de uno recién entregado).
 */

const RECENT_DELIVERED_MS = 3 * 60 * 60_000;

function time(date: Date) {
  return date.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });
}

type Row = {
  trip: Trip;
  courierName: string | null;
  deliveredAt: Date | null;
  deliveryPlace: "customer" | "gate" | null;
  assignment: typeof schema.assignments.$inferSelect | null;
  courier: { lat: number | null; lng: number | null; locationUpdatedAt: Date | null } | null;
};

async function load(conversationId: number, tripId: number | null): Promise<Row[]> {
  const since = new Date(Date.now() - RECENT_DELIVERED_MS);
  return db
    .select({
      trip: schema.trips,
      courierName: schema.assignments.courierName,
      deliveredAt: schema.assignments.deliveredAt,
      deliveryPlace: schema.assignments.deliveryPlace,
      assignment: schema.assignments,
      courier: { lat: schema.couriers.lat, lng: schema.couriers.lng, locationUpdatedAt: schema.couriers.locationUpdatedAt },
    })
    .from(schema.trips)
    .leftJoin(schema.assignments, eq(schema.assignments.tripId, schema.trips.id))
    .leftJoin(schema.couriers, eq(schema.couriers.id, schema.assignments.courierId))
    .where(
      and(
        eq(schema.trips.conversationId, conversationId),
        tripId !== null
          ? eq(schema.trips.id, tripId)
          : or(
              inArray(schema.trips.status, ["pending", "assigned", "en_route"]),
              and(eq(schema.trips.status, "delivered"), gt(schema.trips.updatedAt, since)),
            ),
      ),
    )
    .orderBy(desc(schema.trips.createdAt));
}

/** Lo que tarda en llegar el domiciliario al restaurante, regla estándar. */
export const PICKUP_WINDOW = "10 - 15 minutos";

/** El tope que el restaurante espera por regla general. Pasado este tiempo
 *  se le piden excusas y se le dice por qué. */
const STANDARD_MAX_MIN = 15;

/** Sin moto libre, cuánto se estima que tarda la primera en desocuparse y
 *  llegar. Es un tranquilizador, no una promesa exacta. */
const BUSY_FLEET_MIN = 20;

/** Las calles reales son más largas que la línea recta. */
const ROAD_FACTOR = 1.4;

/** Una posición más vieja que esto no sirve para estimar. */
const FRESH_LOCATION_MS = 15 * 60_000;

/** Horas pico en Cali (almuerzo y comida), hora de Colombia. */
function isPeakHour(at: Date): boolean {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Bogota" })
    .format(at)
    .split(":")
    .map(Number);
  const min = h * 60 + m;
  return (min >= 11 * 60 + 30 && min < 14 * 60) || (min >= 18 * 60 && min < 21 * 60);
}

/** El margen que se suma en silencio por el tráfico, que no se conoce: si
 *  el domiciliario llega antes, mejor. En hora pico es mayor. */
export function trafficMargin(at: Date = new Date()): number {
  return isPeakHour(at) ? 7 : 4;
}

type Point = { lat: number; lng: number };

export type PickupEstimate = {
  /** Minutos hasta que el domiciliario esté en el restaurante, con margen. */
  minutes: number;
  /** Por qué pasa de 15: la comida tarda más (no es demora nuestra), las
   *  motos están ocupadas o la más cercana viene lejos. */
  reason: "standard" | "food" | "busy" | "far";
};

/**
 * Cuánto se le dice al restaurante que tarda el domiciliario. El despacho
 * ya busca que llegue justo cuando la comida esté lista; este tiempo solo
 * lo tranquiliza, así que va con margen y por lo general el domiciliario
 * llega antes.
 */
export function estimatePickup(opts: {
  readyAt: Date | null;
  pickup: Point | null;
  courier?: { lat: number | null; lng: number | null; locationUpdatedAt: Date | null } | null;
  now?: Date;
}): PickupEstimate {
  const now = opts.now ?? new Date();
  const margin = trafficMargin(now);
  const readyIn = opts.readyAt ? Math.max(0, Math.ceil((opts.readyAt.getTime() - now.getTime()) / 60_000)) : 0;

  let travel: number;
  let slow: PickupEstimate["reason"];
  const c = opts.courier;
  if (!c) {
    travel = BUSY_FLEET_MIN;
    slow = "busy";
  } else if (c.lat != null && c.lng != null && opts.pickup && c.locationUpdatedAt && now.getTime() - c.locationUpdatedAt.getTime() < FRESH_LOCATION_MS) {
    travel = estimateEtaMinutes(haversineKm({ lat: c.lat, lng: c.lng }, opts.pickup) * ROAD_FACTOR);
    slow = "far";
  } else {
    // Moto libre sin posición reciente: la regla estándar.
    travel = 10;
    slow = "far";
  }

  const courierMin = travel + margin;
  // Redondeado a 5 hacia arriba: «unos 20 minutos» suena a estimado, no a promesa.
  const round = (n: number) => Math.ceil(n / 5) * 5;
  if (readyIn > STANDARD_MAX_MIN && readyIn >= courierMin) return { minutes: readyIn, reason: "food" };
  const minutes = round(Math.max(courierMin, readyIn));
  return { minutes, reason: minutes > STANDARD_MAX_MIN ? slow : "standard" };
}

const DELAY_REASON: Record<"busy" | "far", string> = {
  busy: "todas las motos están terminando otros servicios en este momento",
  far: "la moto disponible más cercana viene de otro sector",
};

/** Cuándo llega, dicho al restaurante. */
export function pickupEtaText(e: PickupEstimate): string {
  if (e.reason === "food") return `El domiciliario estará ahí para cuando esté lista (en ${e.minutes} min).`;
  if (e.reason === "standard") return `El domiciliario estará ahí en ${e.minutes <= 10 ? "unos 10 minutos" : PICKUP_WINDOW}.`;
  return `El domiciliario estará ahí en unos ${e.minutes} minutos. Disculpa la demora: ${DELAY_REASON[e.reason]}.`;
}

/** El restaurante nunca recibe el número del domiciliario: la agencia es
 *  la intermediaria y le pasa lo que necesite. */
export const COURIER_CONTACT_NOTE = "Si necesitas algo del domiciliario, escríbenos por aquí y nosotros le avisamos.";

/**
 * La confirmación al restaurante, siempre apenas confirma: haya moto libre
 * o no, el servicio queda confirmado y con un tiempo. La espera por
 * eficiencia del despacho no es suya. Solo el nombre del domiciliario,
 * nunca su número.
 */
export function confirmedText(code: string, estimate: PickupEstimate, courierName?: string | null, fee?: string): string {
  const price = fee ? ` · ${fee}` : "";
  const who = courierName ? `Va ${courierName}. ` : "";
  return `✅ Servicio motorizado confirmado para el pedido ${code}${price}.\n\n🛵 ${who}${pickupEtaText(estimate)}\n\n${COURIER_CONTACT_NOTE}`;
}

/** La moto se asignó después de confirmar: solo quién va. */
export function courierAssignedText(code: string, courierName: string): string {
  return `🛵 Pedido ${code}: va ${courierName}.`;
}

/** La fase del viaje vista desde el restaurante (domain/phase.ts). */
function phaseOf(row: Row): TripPhase {
  const a = row.assignment;
  return tripPhase({ status: row.trip.status, ...(a ?? {}), deliveryPlace: a?.deliveryPlace ?? null });
}

/** La posición de la moto, si es reciente: sin ella no se estima nada. */
function courierAt(row: Row, now: Date): Point | null {
  const c = row.courier;
  if (!c || c.lat == null || c.lng == null || !c.locationUpdatedAt || now.getTime() - c.locationUpdatedAt.getTime() >= FRESH_LOCATION_MS) return null;
  return { lat: c.lat, lng: c.lng };
}

/** «unos 10 minutos» hasta un punto, desde la moto; null sin posición o sin destino. */
function minutesTo(row: Row, target: Point | null | undefined, now: Date): number | null {
  const from = courierAt(row, now);
  if (!from || !target) return null;
  return Math.max(5, Math.ceil((estimateEtaMinutes(haversineKm(from, target) * ROAD_FACTOR) + trafficMargin(now)) / 5) * 5);
}

/**
 * En qué va un pedido con moto, dicho al restaurante: si ya va para allá (y
 * en cuánto llega), si ya está ahí, si ya lo recogió y va donde el cliente, o
 * si el cliente no contesta. Solo el nombre del domiciliario.
 */
function onTheWayText(row: Row, where: string, courier: string, now = new Date()): string {
  const { trip } = row;
  const phase = phaseOf(row);
  if (phase === "unread" || phase === "read" || phase === "going") {
    const eta = estimatePickup({ readyAt: trip.readyAt, pickup: trip.pickupLocation ?? null, courier: row.courier ?? null, now });
    const lead = phase === "going" ? `${courier} va en camino a recogerlo` : `${courier} ya tiene el pedido y va para allá`;
    return `🛵 ${trip.code}${where}: ${lead}. Estará ahí en unos ${eta.minutes} minutos.`;
  }
  if (phase === "at_pickup") return `📍 ${trip.code}${where}: ${courier} ya está en el restaurante.`;
  if (phase === "carrying") {
    const eta = minutesTo(row, trip.deliveryLocation, now);
    return `📦 ${trip.code}${where}: ${courier} ya lo recogió y va camino al cliente${eta ? `. Llega en unos ${eta} minutos` : ""}.`;
  }
  if (phase === "at_delivery") return `📍 ${trip.code}${where}: ${courier} ya llegó donde el cliente.`;
  if (phase === "waiting_customer") return `⏰ ${trip.code}${where}: ${courier} está donde el cliente, pero el cliente no contesta. La central ya está al tanto.`;
  if (phase === "undelivered") return `↩️ ${trip.code}${where}: el cliente no contestó y ${courier} lo está devolviendo al restaurante.`;
  return `🛵 ${trip.code}${where}: va ${courier}.`;
}

/**
 * «El domiciliario aún no llega», «ya se demoró mucho», «hace rato pedí»: un
 * reclamo por la demora, no solo una pregunta. Se responde con el estado y,
 * si la moto todavía no ha recogido, pasa a la central para que la llame.
 */
const DELAY_COMPLAINT =
  /\b(?:no (?:ha )?llega(?:do)?|aun no llega|todavia no llega|no (?:ha )?venido|no viene|no vienen|no ha recogido|no lo han recogido|no han venido|no ha ido|no (?:ha )?pasado|no aparece|ya se demoro|se demoro mucho|se ha demorado|se esta demorando mucho|esta muy demorad[oa]|demorad[oa]sim[oa]|tarda(?:ndo)? mucho|se demora mucho|lleva(?:mos)? mucho|hace rato|mucho tiempo|que paso con (?:el )?(?:domi|domiciliario|moto|motorizado|pedido))\b/;

export function looksLikeDelayComplaint(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  const text = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
  return DELAY_COMPLAINT.test(text);
}

/** El motivo del chat que pasa a la central por un reclamo de demora. */
export function delayComplaintReason(codes: string[]): string {
  return `Reclama demora: el domiciliario ${codes.length === 1 ? `del ${codes[0]}` : `de ${codes.join(", ")}`} no ha llegado. Llámalo y confírmale al restaurante.`;
}

export const DELAY_COMPLAINT_ACK = "Ya le aviso a la central para que lo llame y te confirmamos 🙏";

/** Una línea por pedido: dónde va y quién lo lleva (solo el nombre). */
function describe(row: Row, withAddress: boolean) {
  const { trip } = row;
  const where = withAddress ? ` (${trip.deliveryAddress})` : "";
  const courier = row.courierName ?? "un domiciliario";
  // Un encargo lo coordina la central: no hay tiempo de recogida que prometer.
  if (trip.kind === "errand") {
    if (trip.status === "pending") return `🛍️ Encargo ${trip.code}: registrado, la central lo está coordinando.`;
    if (trip.status === "assigned" || trip.status === "en_route") return `🛍️ Encargo ${trip.code}: va ${courier}.\n\n${COURIER_CONTACT_NOTE}`;
    if (trip.status === "delivered") return `🛍️ Encargo ${trip.code}: entregado${row.deliveredAt ? ` a las ${time(row.deliveredAt)}` : ""}`;
    return `❌ Encargo ${trip.code}: cancelado.`;
  }
  switch (trip.status) {
    case "pending":
      return `✅ ${trip.code}${where}: confirmado, el domiciliario estará ahí en ${PICKUP_WINDOW}.`;
    case "assigned":
    case "en_route":
      return onTheWayText(row, where, courier);
    case "delivered":
      // Sin punto final: la hora ya termina en "p. m.".
      return `✅ ${trip.code}${where}: ${row.deliveryPlace === "gate" ? "quedó en portería" : "entregado"}${row.deliveredAt ? ` a las ${time(row.deliveredAt)}` : ""}`;
    default:
      return `❌ ${trip.code}${where}: cancelado.`;
  }
}

export async function answerStatus(conversation: Conversation, phone: string, quoted: Trip | null, opts: { complaint?: boolean } = {}) {
  const rows = await load(conversation.id, quoted?.id ?? null);

  if (!rows.length) {
    await say(conversation.id, phone, "No veo pedidos tuyos en curso 🤔 Si quieres pedir una moto, envíame la dirección de entrega.");
    return;
  }

  // Un reclamo por demora de un pedido que la moto todavía no ha recogido (o
  // que sigue sin moto): además del estado, la central lo revisa.
  const late = opts.complaint ? rows.filter((r) => r.trip.status === "pending" || ((r.trip.status === "assigned" || r.trip.status === "en_route") && (isBeforePickup(phaseOf(r)) || phaseOf(r) === "at_pickup"))) : [];
  const ack = late.length ? DELAY_COMPLAINT_ACK : null;
  if (late.length) {
    await updateConversation(conversation.id, { botPaused: true, escalationReason: delayComplaintReason(late.map((r) => r.trip.code)), failedAttempts: 0 });
  }

  if (rows.length === 1) {
    await say(conversation.id, phone, [describe(rows[0], false), ack].filter(Boolean).join("\n\n"), { replyTo: rows[0].trip.sourceWaMessageId, tripId: rows[0].trip.id });
    return;
  }

  // Varios: uno por pedido, citando el mensaje con que se pidió, como
  // respondería una persona señalando cada uno. Del más viejo al más nuevo.
  // Si dos salieron del mismo mensaje, la dirección dice cuál es cuál.
  const sharedSource = (row: Row) => rows.filter((r) => r.trip.sourceWaMessageId && r.trip.sourceWaMessageId === row.trip.sourceWaMessageId).length > 1;
  for (const row of [...rows].reverse()) {
    const quote = row.trip.sourceWaMessageId;
    await say(conversation.id, phone, describe(row, !quote || sharedSource(row)), { replyTo: quote, tripId: row.trip.id });
  }
  if (ack) await say(conversation.id, phone, ack);
}
