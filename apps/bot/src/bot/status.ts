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

function time(date: Date) {
  return date.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });
}

type Row = {
  trip: Trip;
  courierName: string | null;
  deliveredAt: Date | null;
};

async function load(conversationId: number, tripId: number | null): Promise<Row[]> {
  const since = new Date(Date.now() - RECENT_DELIVERED_MS);
  return db
    .select({
      trip: schema.trips,
      courierName: schema.assignments.courierName,
      deliveredAt: schema.assignments.deliveredAt,
    })
    .from(schema.trips)
    .leftJoin(schema.assignments, eq(schema.assignments.tripId, schema.trips.id))
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

/** Cuándo llega el domiciliario: en la ventana estándar o, si la comida
 *  tarda más, para cuando esté lista. */
export function pickupEta(readyAt: Date | null): string {
  const readyIn = readyAt ? Math.ceil((readyAt.getTime() - Date.now()) / 60_000) : null;
  return readyIn != null && readyIn > 15 ? `para cuando esté lista (en ${readyIn} min)` : `en ${PICKUP_WINDOW}`;
}

/** El restaurante nunca recibe el número del domiciliario: la agencia es
 *  la intermediaria y le pasa lo que necesite. */
export const COURIER_CONTACT_NOTE = "Si necesitas algo del domiciliario, escríbenos por aquí y nosotros le avisamos.";

/** El pedido quedó creado pero todavía no tiene moto: el servicio queda en
 *  espera y se avisa cuando se asigne (`notifyAssigned`). */
export function waitingText(code: string): string {
  return `⏳ Servicio motorizado en espera de asignación para el pedido ${code}.\n\nLas motos están ocupadas, te aviso apenas tenga una asignada.`;
}

/** Ya hay moto: el servicio pasa a confirmado. Solo el nombre del
 *  domiciliario, nunca su número. */
export function confirmedText(code: string, courierName: string, readyAt: Date | null, fee?: string): string {
  const price = fee ? ` · ${fee}` : "";
  return `✅ Servicio motorizado confirmado para el pedido ${code}${price}.\n\nVa ${courierName}, estará ahí ${pickupEta(readyAt)}.\n\n${COURIER_CONTACT_NOTE}`;
}

/** Una línea por pedido: dónde va y quién lo lleva (solo el nombre). */
function describe(row: Row, withAddress: boolean) {
  const { trip } = row;
  const where = withAddress ? ` (${trip.deliveryAddress})` : "";
  const courier = row.courierName ?? "un domiciliario";
  switch (trip.status) {
    case "pending":
      return withAddress ? `${waitingText(trip.code)}\n\n📍 ${trip.deliveryAddress}` : waitingText(trip.code);
    case "assigned":
    case "en_route":
      return `✅ Servicio motorizado confirmado para el pedido ${trip.code}${where}: va ${courier}.\n\n${COURIER_CONTACT_NOTE}`;
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

  // Varios: uno por pedido, citando el mensaje con que se pidió, como
  // respondería una persona señalando cada uno. Del más viejo al más nuevo.
  // Si dos salieron del mismo mensaje, la dirección dice cuál es cuál.
  const sharedSource = (row: Row) => rows.filter((r) => r.trip.sourceWaMessageId && r.trip.sourceWaMessageId === row.trip.sourceWaMessageId).length > 1;
  for (const row of [...rows].reverse()) {
    const quote = row.trip.sourceWaMessageId;
    await say(conversation.id, phone, describe(row, !quote || sharedSource(row)), { replyTo: quote, tripId: row.trip.id });
  }
}
