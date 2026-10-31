import { and, desc, eq, gt, inArray, or } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import type { Conversation } from "@/db/queries/conversation";
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

function formatPhone(phone: string) {
  const d = phone.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : phone;
}

function time(date: Date) {
  return date.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });
}

type Row = {
  trip: Trip;
  courierName: string | null;
  courierPhone: string | null;
  deliveredAt: Date | null;
};

async function load(conversationId: number, tripId: number | null): Promise<Row[]> {
  const since = new Date(Date.now() - RECENT_DELIVERED_MS);
  return db
    .select({
      trip: schema.trips,
      courierName: schema.assignments.courierName,
      courierPhone: schema.couriers.phone,
      deliveredAt: schema.assignments.deliveredAt,
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

/** Una línea por pedido: dónde va y quién lo lleva. */
function describe(row: Row, withAddress: boolean) {
  const { trip } = row;
  const where = withAddress ? ` (${trip.deliveryAddress})` : "";
  const courier = row.courierName ? `${row.courierName}${row.courierPhone ? ` · ${formatPhone(row.courierPhone)}` : ""}` : null;
  switch (trip.status) {
    case "pending":
      return `⏳ ${trip.code}${where}: buscando moto, te aviso apenas se asigne.`;
    case "assigned":
    case "en_route":
      return `🛵 ${trip.code}${where}: va ${courier ?? "un domiciliario"}.`;
    case "delivered":
      // Sin punto final: la hora ya termina en "p. m.".
      return `✅ ${trip.code}${where}: entregado${row.deliveredAt ? ` a las ${time(row.deliveredAt)}` : ""}`;
    default:
      return `❌ ${trip.code}${where}: cancelado.`;
  }
}

export async function answerStatus(conversation: Conversation, phone: string, quoted: Trip | null) {
  const rows = await load(conversation.id, quoted?.id ?? null);

  if (!rows.length) {
    await say(conversation.id, phone, "No veo pedidos tuyos en curso 🤔 Si quieres pedir una moto, envíame la dirección de entrega.");
    return;
  }

  if (rows.length === 1) {
    await say(conversation.id, phone, describe(rows[0], false), { replyTo: rows[0].trip.sourceWaMessageId, tripId: rows[0].trip.id });
    return;
  }

  await say(conversation.id, phone, rows.map((r) => describe(r, true)).join("\n"));
}
