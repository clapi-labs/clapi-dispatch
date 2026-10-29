import { and, desc, eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { conversationForOutbound } from "@/db/queries/conversation";
import type { SendResult } from "@/services/whatsapp/client";

/**
 * Los avisos que salen cuando un viaje cambia de manos. Viven en el bot (el
 * único que habla con Meta) y los dispara quien cambie el estado: el bot
 * mismo al cerrar un pedido, o el portal por `/api/internal/notify`.
 */

export const DELIVER_BUTTON_PREFIX = "deliver:";

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

/** Qué hacer con la plata. Sin método de pago dicho, no se inventa una orden:
 *  el motorizado se guía por las notas o pregunta. */
function moneyLine(trip: typeof schema.trips.$inferSelect) {
  if (trip.paymentMethod === "efectivo") {
    return trip.valueToCollect ? `💵 COBRAR en efectivo: *${cop(trip.valueToCollect)}*` : "💵 Cobrar en efectivo";
  }
  if (trip.paymentMethod === "transferencia") return "💳 Ya pagado. *NO cobrar* al cliente.";
  return trip.valueToCollect ? `💵 Valor del pedido: ${cop(trip.valueToCollect)}` : null;
}

/** La ficha que le llega al motorizado, con el botón de confirmar entrega. */
export function courierTicket(trip: typeof schema.trips.$inferSelect) {
  const customer = [trip.customerName, trip.customerPhone && formatPhone(trip.customerPhone)].filter(Boolean).join(" · ");
  const lines: (string | null | false | undefined)[] = [
    `🛵 *Nuevo viaje ${trip.code}*`,
    "",
    `📍 Recoge: ${trip.originRestaurantName}${trip.pickupAddress ? ` · ${trip.pickupAddress}` : ""}`,
    `🏁 Entrega: ${trip.deliveryAddress}`,
    customer ? `📞 Cliente: ${customer}` : null,
    moneyLine(trip),
    trip.notes && `📝 ${trip.notes}`,
    "",
    trip.deliveryLocation
      ? `🗺️ https://waze.com/ul?ll=${trip.deliveryLocation.lat},${trip.deliveryLocation.lng}&navigate=yes`
      : `🗺️ https://waze.com/ul?q=${encodeURIComponent(`${trip.deliveryAddress}, Cali`)}&navigate=yes`,
    "",
    "Cuando entregues, toca el botón 👇",
  ];
  return lines.filter((l): l is string => typeof l === "string").join("\n");
}

export async function sendCourierTicket(phone: string, trip: typeof schema.trips.$inferSelect): Promise<SendResult> {
  const conversation = await conversationOf(phone);
  return say(conversation.id, phone, courierTicket(trip), {
    tripId: trip.id,
    buttons: [{ id: `${DELIVER_BUTTON_PREFIX}${trip.id}`, title: "✅ Confirmar entrega" }],
  });
}

/** Moto asignada: ficha al motorizado + aviso al restaurante, citando el
 *  mensaje con que pidió ese domicilio. */
export async function notifyAssigned(tripId: number) {
  const row = await loadTrip(tripId);
  if (!row?.courier || !row.assignment) return;

  await sendCourierTicket(row.courier.phone, row.trip);

  const restaurant = await restaurantConversation(row.trip.conversationId);
  if (restaurant) {
    const text = `✅ Pedido ${row.trip.code} confirmado · ${cop(row.trip.deliveryFee)}\n🛵 Va ${row.courier.name} · ${formatPhone(row.courier.phone)}`;
    await say(restaurant.id, restaurant.phone, text, { replyTo: row.trip.sourceWaMessageId, tripId });
  }
}

/** Entregado: confirmación al motorizado y aviso al restaurante. */
export async function notifyDelivered(tripId: number) {
  const row = await loadTrip(tripId);
  if (!row) return;

  if (row.courier) {
    const cash = row.trip.paymentMethod === "efectivo" && row.trip.valueToCollect;
    const text = cash
      ? `✅ Entrega ${row.trip.code} registrada. Recuerda entregar ${cop(row.trip.valueToCollect!)} en base.\nQuedas libre en la cola 🛵`
      : `✅ Entrega ${row.trip.code} registrada. Quedas libre en la cola 🛵`;
    const conversation = await conversationOf(row.courier.phone);
    await say(conversation.id, row.courier.phone, text, { tripId });
  }

  const restaurant = await restaurantConversation(row.trip.conversationId);
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
