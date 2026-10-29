import { and, desc, eq, sql } from "drizzle-orm";

import { completeTrip, db, schema } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { DELIVER_BUTTON_PREFIX, notifyAssigned, notifyDelivered, sendCourierTicket } from "@/bot/notify";
import type { Conversation } from "@/db/queries/conversation";
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

/** El motorizado confirma entregas con el botón de la ficha, o escribe para
 *  "conectarse". */
export async function handleCourier(courier: Courier, conversation: Conversation, message: IncomingMessage) {
  if (message.kind === "button" && message.buttonId.startsWith(DELIVER_BUTTON_PREFIX)) {
    const tripId = Number(message.buttonId.slice(DELIVER_BUTTON_PREFIX.length));
    const result = await completeTrip(tripId);
    if (!result) {
      await say(conversation.id, message.phone, "Ese viaje ya estaba cerrado ✅", { tripId });
      return;
    }
    await notifyDelivered(tripId);
    // La moto que se liberó puede haber tomado un pendiente en el acto.
    for (const id of result.newlyAssigned) await notifyAssigned(id);
    return;
  }

  // Cualquier otro mensaje: si tiene un viaje en curso, se le reenvía la
  // ficha (con el botón); si no, queda conectado y libre.
  const [active] = await db
    .select({ trip: schema.trips })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.assignments.courierId, courier.id), eq(schema.trips.status, "en_route")))
    .orderBy(desc(schema.assignments.assignedAt))
    .limit(1);

  if (active) {
    await sendCourierTicket(message.phone, active.trip);
    return;
  }

  if (courier.status === "offline" || courier.status === "paused") {
    await db.update(schema.couriers).set({ status: "available" }).where(eq(schema.couriers.id, courier.id));
  }
  await say(conversation.id, message.phone, `👋 ${courier.name.split(" ")[0]}, estás conectado a la central. Te escribo apenas tengas un viaje 🛵`);
}
