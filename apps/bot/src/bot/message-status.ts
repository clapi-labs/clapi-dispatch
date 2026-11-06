import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

import type { WaStatus } from "@/services/whatsapp/types";

const NOT_DELIVERED = "⚠️ No se pudo entregar por WhatsApp";

/**
 * Lo que Meta avisa de un mensaje nuestro. Nunca se responde:
 *
 * - `read`: si el mensaje era para el motorizado del viaje, queda la hora en
 *   que lo leyó. Lo que lea el restaurante no cuenta.
 * - `failed`: se marca en el hilo del portal, porque el envío había salido bien
 *   y solo después Meta dijo que no llegó (por ejemplo, fuera de la ventana de
 *   24 horas).
 */
export async function handleMessageStatus(status: WaStatus) {
  if (status.status === "failed") {
    const detail = status.errors?.[0];
    console.error("[whatsapp] mensaje no entregado", status.id, JSON.stringify(detail ?? null));
    const warning = `\n\n${NOT_DELIVERED}${detail?.code ? ` (${detail.code})` : ""}.`;
    await db
      .update(schema.messages)
      .set({ text: sql`${schema.messages.text} || ${warning}` })
      .where(and(eq(schema.messages.waMessageId, status.id), not(sql`${schema.messages.text} like ${`%${NOT_DELIVERED}%`}`)));
    return;
  }

  if (status.status !== "read") return;

  const [message] = await db
    .select({ tripId: schema.messages.tripId })
    .from(schema.messages)
    .where(eq(schema.messages.waMessageId, status.id))
    .limit(1);
  if (!message?.tripId) return;

  const last10 = status.recipient_id.replace(/\D/g, "").slice(-10);
  const courierIds = db
    .select({ id: schema.couriers.id })
    .from(schema.couriers)
    .where(sql`right(regexp_replace(${schema.couriers.phone}, '\\D', '', 'g'), 10) = ${last10}`);
  await db
    .update(schema.assignments)
    .set({ readAt: new Date() })
    .where(and(eq(schema.assignments.tripId, message.tripId), isNull(schema.assignments.readAt), inArray(schema.assignments.courierId, courierIds)));
}
