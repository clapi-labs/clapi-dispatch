import { and, desc, eq, isNull, lte } from "drizzle-orm";

import { db, getBotConfig, schema } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { confirmedText, courierAssignedText, estimatePickup } from "@/bot/status";
import { conversationForOutbound } from "@/db/queries/conversation";
import type { SendResult } from "@/services/whatsapp/client";

/**
 * Los avisos que salen cuando un viaje cambia de manos. Viven en el bot (el
 * único que habla con Meta) y los dispara quien cambie el estado: el bot
 * mismo al cerrar un pedido, o el portal por `/api/internal/notify`.
 */

export const DELIVER_BUTTON_PREFIX = "deliver:";
/** «Vi el pedido»: el motorizado confirma que leyó la ficha. */
export const SEEN_BUTTON_PREFIX = "seen:";

const DELIVER_HINT = "Cuando termines, toca el botón. Si tienes que volver al restaurante (por el cambio, por ejemplo), tócalo al volver.";
const SEEN_HINT = "Toca «Vi el pedido» apenas lo leas, para que la central sepa que vas.";

const deliverButton = (tripId: number) => ({ id: `${DELIVER_BUTTON_PREFIX}${tripId}`, title: "Terminé el servicio" });
const seenButton = (tripId: number) => ({ id: `${SEEN_BUTTON_PREFIX}${tripId}`, title: "✅ Vi el pedido" });

function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] || null;
}

/** La respuesta a «Vi el pedido», ya con el botón de terminar. */
export function seenAckText(pickup: string) {
  return `Listo 👍 Te esperan en ${pickup}.\n\n${DELIVER_HINT}`;
}

/** El recordatorio a quien no ha tocado «Vi el pedido». */
export function seenReminderText(trip: Pick<typeof schema.trips.$inferSelect, "code" | "originRestaurantName">, courierName: string | null) {
  const name = firstName(courierName);
  return `⏰ ${name ? `${name}, ¿viste` : "¿Viste"} el pedido ${trip.code}? Recoge en ${trip.originRestaurantName}.\n\nConfírmame con el botón apenas lo leas.`;
}

function cop(n: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
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
function moneyLine(trip: typeof schema.trips.$inferSelect) {
  if (trip.paymentMethod === "transferencia") return "Ya está pagado, no cobres.";
  const value = trip.valueToCollect ? ` ${cop(trip.valueToCollect)}` : "";
  if (trip.paymentMethod === "efectivo") return `Cobra en efectivo${value}.`;
  return value ? `Valor del pedido:${value}.` : null;
}

/** La ficha que le llega al motorizado, con el botón de confirmar entrega.
 *  Una idea por párrafo, separados por una línea en blanco, para leerla
 *  rápido desde la moto. */
export function courierTicket(trip: typeof schema.trips.$inferSelect, courierName?: string | null, seen = false) {
  const first = firstName(courierName);
  const customer = [trip.customerName, trip.customerPhone && formatPhone(trip.customerPhone)].filter(Boolean).join(" · ");
  const waze = trip.deliveryLocation
    ? `https://waze.com/ul?ll=${trip.deliveryLocation.lat},${trip.deliveryLocation.lng}&navigate=yes`
    : // Solo la calle: la torre y el apto («· Torre 4 apto 302») confunden la búsqueda.
      `https://waze.com/ul?q=${encodeURIComponent(`${trip.deliveryAddress.split(" · ")[0]}, Cali`)}&navigate=yes`;
  const paragraphs: (string | null | false | undefined)[] = [
    `🛵 *${first ? `${first}, tienes` : "Tienes"} un nuevo viaje ${trip.code}*`,
    `*Recoge en:* ${trip.originRestaurantName}${trip.pickupAddress ? ` · ${trip.pickupAddress}` : ""}`,
    `*Entrega en:* ${trip.deliveryAddress}`,
    customer ? `*Cliente:* ${customer}` : null,
    moneyLine(trip),
    trip.notes && `*Indicaciones:* ${trip.notes}`,
    `*Ruta en Waze:* ${waze}`,
    // Primero confirma que la vio; el botón de terminar llega después.
    seen ? DELIVER_HINT : SEEN_HINT,
  ];
  return paragraphs.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}

/** La ficha con un solo botón: «Vi el pedido» si todavía no la confirmó,
 *  «Terminé el servicio» si ya (cuando la vuelve a pedir, por ejemplo). */
export async function sendCourierTicket(
  phone: string,
  trip: typeof schema.trips.$inferSelect,
  courierName?: string | null,
  seen = false,
): Promise<SendResult> {
  const conversation = await conversationOf(phone);
  return say(conversation.id, phone, courierTicket(trip, courierName, seen), {
    tripId: trip.id,
    buttons: [seen ? deliverButton(trip.id) : seenButton(trip.id)],
  });
}

/** Moto asignada: ficha al motorizado + aviso al restaurante, citando el
 *  mensaje con que pidió ese domicilio. Si se asignó al confirmar
 *  (`atConfirmation`), el aviso es la confirmación con el tiempo; si se
 *  asignó después, el restaurante ya tiene su confirmación y solo se le
 *  dice quién va. */
export async function notifyAssigned(tripId: number, opts: { atConfirmation?: boolean } = {}) {
  const row = await loadTrip(tripId);
  if (!row?.courier || !row.assignment) return;
  await sendCourierTicket(row.courier.phone, row.trip, row.courier.name);

  const restaurant = await restaurantConversation(row.trip.conversationId);
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

/**
 * El motorizado confirmó que vio el pedido: se le responde con el botón de
 * terminar, citando su ficha. Al restaurante no se le dice nada: ya tiene su
 * confirmación desde que pidió.
 */
export async function notifySeen(tripId: number) {
  const row = await loadTrip(tripId);
  if (!row?.courier || !row.assignment) return;

  const conversation = await conversationOf(row.courier.phone);
  const pickup = [row.trip.originRestaurantName, row.trip.pickupAddress].filter(Boolean).join(" · ");
  await say(conversation.id, row.courier.phone, seenAckText(pickup), {
    replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
    tripId,
    buttons: [deliverButton(tripId)],
  });
}

/**
 * Lo corre el tick: a quien lleva `seenReminderMinutes` sin tocar «Vi el
 * pedido», se le recuerda una vez, citando la ficha. Cada recordatorio se
 * reclama con un UPDATE condicional, así que dos ticks a la vez no lo mandan
 * dos veces. Devuelve los viajes recordados.
 */
export async function remindUnseen(): Promise<number[]> {
  const { seenReminderMinutes } = await getBotConfig();
  const before = new Date(Date.now() - seenReminderMinutes * 60_000);
  const due = await db
    .select({ tripId: schema.assignments.tripId })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(
      and(
        eq(schema.trips.status, "en_route"),
        isNull(schema.assignments.seenAt),
        isNull(schema.assignments.seenReminderAt),
        lte(schema.assignments.assignedAt, before),
      ),
    );

  const reminded: number[] = [];
  for (const { tripId } of due) {
    const [claimed] = await db
      .update(schema.assignments)
      .set({ seenReminderAt: new Date() })
      .where(and(eq(schema.assignments.tripId, tripId), isNull(schema.assignments.seenAt), isNull(schema.assignments.seenReminderAt)))
      .returning({ tripId: schema.assignments.tripId });
    if (!claimed) continue;
    const row = await loadTrip(tripId);
    if (!row?.courier) continue;
    const conversation = await conversationOf(row.courier.phone);
    await say(conversation.id, row.courier.phone, seenReminderText(row.trip, row.courier.name), {
      replyTo: await lastBotMessageAbout(tripId, row.courier.phone),
      tripId,
      buttons: [seenButton(tripId)],
    });
    reminded.push(tripId);
  }
  return reminded;
}

/** Servicio terminado: los avisos que la agencia tenga encendidos. */
export async function notifyDelivered(tripId: number) {
  const [row, config] = await Promise.all([loadTrip(tripId), getBotConfig()]);
  if (!row) return;

  if (row.courier && config.confirmDeliveryToCourier) {
    const conversation = await conversationOf(row.courier.phone);
    await say(conversation.id, row.courier.phone, `✅ ${row.trip.code} terminado. Quedas libre 🛵`, { tripId });
  }

  const restaurant = config.notifyRestaurantOnDelivery ? await restaurantConversation(row.trip.conversationId) : null;
  if (restaurant) {
    const time = new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });
    await say(restaurant.id, restaurant.phone, `📦 Pedido ${row.trip.code} entregado a las ${time} ✅`, {
      replyTo: row.trip.sourceWaMessageId,
      tripId,
    });
  }
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
