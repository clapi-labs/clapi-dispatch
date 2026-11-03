import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { completeTrip, db, schema } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { DELIVER_BUTTON_PREFIX, notifyAssigned, notifyDelivered, sendCourierTicket } from "@/bot/notify";
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

/** Lo que el motorizado tiene en curso, el más reciente primero. */
async function activeTrips(courierId: number) {
  const rows = await db
    .select({ trip: schema.trips })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.assignments.courierId, courierId), inArray(schema.trips.status, ["assigned", "en_route"])))
    .orderBy(desc(schema.assignments.assignedAt));
  return rows.map((r) => r.trip);
}

/**
 * Lo normal es que el motorizado no escriba: recibe la ficha y toca
 * «Terminé el servicio». Por eso un mensaje suyo solo se responde cuando
 * hace falta (docs/BOT.md, «Mensajes por servicio»):
 *
 * - Novedad (accidente, no puede ir, el cliente no baja…): queda en pausa
 *   (no se le asigna nada más, conserva lo que lleva) y su chat pasa a la
 *   central, que decide qué hacer (docs/INTERVENCION-MANUAL.md).
 * - Pide la ficha: se le reenvía.
 * - «Ok», «voy», «ya recogí»: nada.
 */
export async function handleCourier(courier: Courier, conversation: Conversation, message: IncomingMessage) {
  if (message.kind === "button" && message.buttonId.startsWith(DELIVER_BUTTON_PREFIX)) {
    const tripId = Number(message.buttonId.slice(DELIVER_BUTTON_PREFIX.length));
    const result = await completeTrip(tripId);
    if (!result) {
      await say(conversation.id, message.phone, "Ese servicio ya estaba cerrado ✅", { tripId });
      return;
    }
    await notifyDelivered(tripId);
    // La moto que se liberó puede haber tomado un pendiente en el acto.
    for (const id of result.newlyAssigned) await notifyAssigned(id);
    return;
  }

  // Con la central al frente de su chat, el bot no se mete.
  if (conversation.botPaused) return;

  const trips = await activeTrips(courier.id);
  const intent = message.kind === "text" ? await classifyCourierMessage(message.text) : { kind: "otro" as const, summary: null };

  if (intent.kind === "novedad") {
    const codes = trips.map((t) => t.code).join(", ");
    const reason = `Novedad de ${courier.name}${codes ? ` (${codes})` : ""}: ${intent.summary ?? "revisar su chat"}`;
    await db.update(schema.couriers).set({ status: "paused" }).where(eq(schema.couriers.id, courier.id));
    await updateConversation(conversation.id, { botPaused: true, escalationReason: reason });
    await say(conversation.id, message.phone, "Recibido 🙏 La central ya te contacta.", { tripId: trips[0]?.id ?? null });
    return;
  }

  if (intent.kind === "ficha" && trips.length) {
    for (const trip of trips) await sendCourierTicket(message.phone, trip);
    return;
  }

  // Sin viajes y desconectado: escribir es conectarse. En pausa no: esa la
  // pone y la quita la central.
  if (!trips.length && courier.status === "offline") {
    await db.update(schema.couriers).set({ status: "available" }).where(eq(schema.couriers.id, courier.id));
    await say(conversation.id, message.phone, `👋 ${courier.name.split(" ")[0]}, quedaste conectado. Te escribo apenas tengas un servicio 🛵`);
  }
}
