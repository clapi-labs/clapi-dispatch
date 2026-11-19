import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

import { AGENCY_RATE, byDay, onDay, summarize, type DeliveredRow } from "@/lib/settlement-calc";
import type { Settlement } from "@/lib/types";
import { bogotaDate, weekRange } from "@/lib/week";

/**
 * El cierre, desde los viajes entregados (hora de Colombia, lunes a domingo).
 * Solo importan los domicilios: lo que el cliente le paga al restaurante y lo
 * que se le devuelve no es de la agencia.
 *
 * - **Total generado**: la suma de los domicilios (`deliveryFee`).
 * - **Para la agencia**: su porcentaje sobre ese total (`AGENCY_RATE`).
 * - **Por moto**: viajes, lo que generó y la parte de la agencia.
 *
 * Sin filtros es el cierre de hoy (como siempre). Con `semana` (cualquier fecha
 * de esa semana) es el acumulado lunes–domingo más el resumen de cada día; con
 * `dia` además, el detalle de ese día. Los límites de los días los calcula
 * `lib/week.ts`: nunca por la zona del servidor.
 */
export { AGENCY_RATE };

export type SettlementFilter = {
  /** Cualquier fecha `YYYY-MM-DD` de la semana pedida. */
  semana?: string;
  /** Un día `YYYY-MM-DD` dentro de esa semana. */
  dia?: string;
};

async function deliveredBetween(from: Date, to: Date): Promise<DeliveredRow[]> {
  const rows = await db
    .select({
      courierId: schema.assignments.courierId,
      courierName: schema.assignments.courierName,
      deliveryFee: schema.trips.deliveryFee,
      deliveredAt: schema.assignments.deliveredAt,
    })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.trips.status, "delivered"), gte(schema.assignments.deliveredAt, from), lt(schema.assignments.deliveredAt, to)));
  return rows.flatMap((r) => (r.deliveredAt ? [{ ...r, deliveredAt: r.deliveredAt }] : []));
}

export async function getSettlement(filter: SettlementFilter = {}): Promise<Settlement> {
  if (!filter.semana && !filter.dia) {
    // Sin filtros: solo hoy. Sin tope superior, como siempre (algo «de hoy» más tarde sigue siendo de hoy).
    const rows = await db
      .select({
        courierId: schema.assignments.courierId,
        courierName: schema.assignments.courierName,
        deliveryFee: schema.trips.deliveryFee,
        deliveredAt: schema.assignments.deliveredAt,
      })
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(
        and(
          eq(schema.trips.status, "delivered"),
          gte(schema.assignments.deliveredAt, sql`date_trunc('day', now() at time zone 'America/Bogota') at time zone 'America/Bogota'`),
        ),
      );
    return summarize(rows.flatMap((r) => (r.deliveredAt ? [{ ...r, deliveredAt: r.deliveredAt }] : [])));
  }

  const anchor = filter.dia ?? filter.semana ?? bogotaDate(Date.now());
  const week = weekRange(filter.semana ?? anchor);
  const rows = await deliveredBetween(week.from, week.to);
  const day = filter.dia ?? null;
  return {
    ...summarize(day ? onDay(rows, day) : rows),
    week: { start: week.start, end: week.end },
    days: byDay(rows, week.start),
    day,
  };
}
