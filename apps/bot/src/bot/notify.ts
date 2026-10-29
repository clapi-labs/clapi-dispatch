import { eq } from "drizzle-orm";

import { ASSIGNED_MESSAGE } from "@dispatch/shared";
import { db, schema } from "@dispatch/shared/db";

import { recordMessage } from "@/db/queries/conversation";
import { sendButtons, sendText, type SendResult } from "@/services/whatsapp/client";

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

async function conversationOf(phone: string) {
  const [c] = await db.select().from(schema.conversations).where(eq(schema.conversations.phone, phone));
  return c ?? null;
}

async function restaurantPhone(conversationId: number | null) {
  if (!conversationId) return null;
  const [c] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  return c ?? null;
}

/** La ficha que le llega al motorizado, con el botón de confirmar entrega. */
export function courierTicket(trip: typeof schema.trips.$inferSelect) {
  const money =
    trip.paymentMethod === "efectivo"
      ? `💵 COBRAR en efectivo: *${cop(trip.valueToCollect)}*`
      : `💳 Ya pagado. *NO cobrar* al cliente.`;
  return [
    `🛵 *Nuevo viaje ${trip.code}*`,
    "",
    `📍 Recoge: ${trip.originRestaurantName}${trip.pickupAddress ? ` · ${trip.pickupAddress}` : ""}`,
    `🏁 Entrega: ${trip.deliveryAddress}`,
    `📞 Cliente: ${trip.customerPhone}`,
    money,
    "",
    `🗺️ https://waze.com/ul?q=${encodeURIComponent(`${trip.deliveryAddress}, Cali`)}&navigate=yes`,
    "",
    "Cuando entregues, toca el botón 👇",
  ].join("\n");
}

export async function sendCourierTicket(phone: string, trip: typeof schema.trips.$inferSelect): Promise<SendResult> {
  const text = courierTicket(trip);
  const result = await sendButtons(phone, text, [{ id: `${DELIVER_BUTTON_PREFIX}${trip.id}`, title: "✅ Confirmar entrega" }]);
  const conversation = await conversationOf(phone);
  if (conversation) {
    await recordMessage(conversation.id, "bot", result.ok ? text : `${text}\n\n⚠️ No se pudo enviar por WhatsApp (${result.reason}).`);
  }
  return result;
}

/** Moto asignada: ficha al motorizado + confirmación al restaurante. */
export async function notifyAssigned(tripId: number) {
  const row = await loadTrip(tripId);
  if (!row?.courier || !row.assignment) return;

  await sendCourierTicket(row.courier.phone, row.trip);

  const restaurant = await restaurantPhone(row.trip.conversationId);
  if (restaurant) {
    const text = `✅ ${ASSIGNED_MESSAGE}\n\n🛵 ${row.courier.name}\n📦 Pedido ${row.trip.code} · Domicilio ${cop(row.trip.deliveryFee)}`;
    await recordMessage(restaurant.id, "bot", text);
    await sendText(restaurant.phone, text);
  }
}

/** Entregado: confirmación al motorizado y aviso al restaurante. */
export async function notifyDelivered(tripId: number) {
  const row = await loadTrip(tripId);
  if (!row) return;

  if (row.courier) {
    const text =
      row.trip.paymentMethod === "efectivo"
        ? `✅ Entrega ${row.trip.code} registrada. Recuerda entregar ${cop(row.trip.valueToCollect)} en base.\nQuedas libre en la cola 🛵`
        : `✅ Entrega ${row.trip.code} registrada. Quedas libre en la cola 🛵`;
    const conversation = await conversationOf(row.courier.phone);
    if (conversation) await recordMessage(conversation.id, "bot", text);
    await sendText(row.courier.phone, text);
  }

  const restaurant = await restaurantPhone(row.trip.conversationId);
  if (restaurant) {
    const text = `📦 Pedido ${row.trip.code} entregado a las ${new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" })} ✅`;
    await recordMessage(restaurant.id, "bot", text);
    await sendText(restaurant.phone, text);
  }
}
