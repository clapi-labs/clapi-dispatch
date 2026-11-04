import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { completeTrip, db, schema } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { DELIVER_BUTTON_PREFIX, SEEN_BUTTON_PREFIX, notifyAssigned, notifyDelivered, notifySeen, sendCourierTicket } from "@/bot/notify";
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

/** Lo que el motorizado tiene en curso, el más reciente primero, y si ya
 *  confirmó que lo vio. */
async function activeTrips(courierId: number) {
  const rows = await db
    .select({ trip: schema.trips, seenAt: schema.assignments.seenAt })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.assignments.courierId, courierId), inArray(schema.trips.status, ["assigned", "en_route"])))
    .orderBy(desc(schema.assignments.assignedAt));
  return rows.map((r) => ({ ...r.trip, seen: r.seenAt !== null }));
}

/** «Ok», «voy», «ya lo vi», «recibido», 👍: un acuse corto, sin nada más. */
const ACK = /^(ok[aiy]?|okey|listo|visto|ya lo vi|lo vi|ya vi|voy|ya voy|vamos|va|dale|de una|recibido|enterado|copiado|en camino|voy para all[aá]|s[ií])[\s!.,👍✅🛵🙏]*$|^[\s👍✅🛵🙏]+$/iu;

export function isAck(text: string) {
  return ACK.test(text.trim());
}

/**
 * «Vi el pedido»: guarda la hora (solo la primera vez y solo si el viaje
 * sigue a su nombre) y avisa. Devuelve `false` si no había nada que confirmar.
 */
async function markSeen(courierId: number, tripId: number) {
  const [row] = await db
    .update(schema.assignments)
    .set({ seenAt: new Date() })
    .where(and(eq(schema.assignments.tripId, tripId), eq(schema.assignments.courierId, courierId), isNull(schema.assignments.seenAt)))
    .returning({ tripId: schema.assignments.tripId });
  if (!row) return false;
  await notifySeen(tripId);
  return true;
}

/**
 * Lo normal es que el motorizado no escriba: recibe la ficha, toca «Vi el
 * pedido» (o responde «ok», «voy») y al final «Terminé el servicio». Por eso un mensaje suyo solo se responde cuando
 * hace falta (docs/BOT.md, «Mensajes por servicio»):
 *
 * - Novedad (accidente, no puede ir, el cliente no baja…): queda en pausa
 *   (no se le asigna nada más, conserva lo que lleva) y su chat pasa a la
 *   central, que decide qué hacer (docs/INTERVENCION-MANUAL.md).
 * - Pide la ficha: se le reenvía.
 * - «Ok», «voy» con un pedido sin confirmar: lo confirma. Si no, nada.
 */
export async function handleCourier(courier: Courier, conversation: Conversation, message: IncomingMessage) {
  if (message.kind === "button" && message.buttonId.startsWith(SEEN_BUTTON_PREFIX)) {
    const tripId = Number(message.buttonId.slice(SEEN_BUTTON_PREFIX.length));
    if (await markSeen(courier.id, tripId)) return;
    // Doble toque, o el viaje ya no es suyo (se lo pasaron a otra moto o se cerró).
    const mine = (await activeTrips(courier.id)).find((t) => t.id === tripId);
    await say(conversation.id, message.phone, mine ? "Ya lo tenías confirmado ✅" : "Ese servicio ya no está a tu nombre 🙏", { tripId });
    return;
  }

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

  // Un «ok» o «voy» con un pedido sin confirmar es confirmarlo: así lo hacen
  // hoy muchos. Con varios sin confirmar, el más viejo primero.
  const unseen = trips.filter((t) => !t.seen);
  if (message.kind === "text" && unseen.length && isAck(message.text)) {
    await markSeen(courier.id, unseen[unseen.length - 1].id);
    return;
  }

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
    for (const trip of trips) await sendCourierTicket(message.phone, trip, courier.name, trip.seen);
    return;
  }

  // Sin viajes y desconectado: escribir es conectarse. En pausa no: esa la
  // pone y la quita la central.
  if (!trips.length && courier.status === "offline") {
    await db.update(schema.couriers).set({ status: "available" }).where(eq(schema.couriers.id, courier.id));
    await say(conversation.id, message.phone, `👋 ${courier.name.split(" ")[0]}, quedaste conectado. Te escribo apenas tengas un servicio 🛵`);
  }
}
