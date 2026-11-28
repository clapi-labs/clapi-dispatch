import { and, eq, gte, isNotNull, lt, sql, type SQL } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

import { AGENCY_RATE, byDay, onDay, summarize, type DeliveredRow } from "@/lib/settlement-calc";
import type { Settlement } from "@/lib/types";
import { bogotaDate, weekRange } from "@/lib/week";

/**
 * El cierre, desde los viajes entregados y los cancelados con cobro (hora de
 * Colombia, lunes a domingo).
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

/**
 * Lo que cuenta en el cierre entre `from` y `to` (sin `to`, hasta ahora): los
 * entregados, a su hora de entrega, y los cancelados con cobro
 * (`trips.cancel_fee`), a su hora de cancelación y con lo cobrado.
 */
async function chargedBetween(from: Date | SQL, to?: Date): Promise<DeliveredRow[]> {
  const select = {
    courierId: schema.assignments.courierId,
    courierName: schema.assignments.courierName,
    deliveryFee: schema.trips.deliveryFee,
    cancelFee: schema.trips.cancelFee,
    deliveredAt: schema.assignments.deliveredAt,
    cancelledAt: schema.trips.cancelledAt,
  };
  const [delivered, cancelled] = await Promise.all([
    db
      .select(select)
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(and(eq(schema.trips.status, "delivered"), gte(schema.assignments.deliveredAt, from), to ? lt(schema.assignments.deliveredAt, to) : undefined)),
    db
      .select(select)
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(
        and(
          eq(schema.trips.status, "cancelled"),
          isNotNull(schema.trips.cancelFee),
          gte(schema.trips.cancelledAt, from),
          to ? lt(schema.trips.cancelledAt, to) : undefined,
        ),
      ),
  ]);
  return [
    ...delivered.flatMap((r) => (r.deliveredAt ? [{ courierId: r.courierId, courierName: r.courierName, deliveryFee: r.deliveryFee, deliveredAt: r.deliveredAt }] : [])),
    ...cancelled.flatMap((r) => (r.cancelledAt && r.cancelFee ? [{ courierId: r.courierId, courierName: r.courierName, deliveryFee: r.cancelFee, deliveredAt: r.cancelledAt }] : [])),
  ];
}

export async function getSettlement(filter: SettlementFilter = {}): Promise<Settlement> {
  if (!filter.semana && !filter.dia) {
    // Sin filtros: solo hoy. Sin tope superior, como siempre (algo «de hoy» más tarde sigue siendo de hoy).
    return summarize(await chargedBetween(sql`date_trunc('day', now() at time zone 'America/Bogota') at time zone 'America/Bogota'`));
  }

  const anchor = filter.dia ?? filter.semana ?? bogotaDate(Date.now());
  const week = weekRange(filter.semana ?? anchor);
  const rows = await chargedBetween(week.from, week.to);
  const day = filter.dia ?? null;
  return {
    ...summarize(day ? onDay(rows, day) : rows),
    week: { start: week.start, end: week.end },
    days: byDay(rows, week.start),
    day,
  };
}
