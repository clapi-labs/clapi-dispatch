import { and, eq, gte, sql } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

import type { Settlement, SettlementRow } from "@/lib/types";

/**
 * El cierre del día, desde los viajes entregados hoy (hora de Colombia).
 * Solo importan los domicilios: lo que el cliente le paga al restaurante y lo
 * que se le devuelve no es de la agencia.
 *
 * - **Total generado**: la suma de los domicilios (`deliveryFee`).
 * - **Para la agencia**: su porcentaje sobre ese total (`AGENCY_RATE`).
 * - **Por moto**: viajes, lo que generó y la parte de la agencia.
 */
export const AGENCY_RATE = 0.1;

export async function getSettlement(): Promise<Settlement> {
  const rows = await db
    .select({
      courierId: schema.assignments.courierId,
      courierName: schema.assignments.courierName,
      deliveryFee: schema.trips.deliveryFee,
    })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(
      and(
        eq(schema.trips.status, "delivered"),
        gte(schema.assignments.deliveredAt, sql`date_trunc('day', now() at time zone 'America/Bogota') at time zone 'America/Bogota'`),
      ),
    );

  const byCourier = new Map<string, SettlementRow>();
  let total = 0;
  for (const row of rows) {
    total += row.deliveryFee;
    const entry = byCourier.get(row.courierName) ?? { courierId: row.courierId ?? 0, courierName: row.courierName, deliveredCount: 0, earned: 0, agencyShare: 0 };
    entry.deliveredCount += 1;
    entry.earned += row.deliveryFee;
    byCourier.set(row.courierName, entry);
  }
  for (const entry of byCourier.values()) entry.agencyShare = Math.round(entry.earned * AGENCY_RATE);

  return {
    total,
    deliveredCount: rows.length,
    averageFee: rows.length ? Math.round(total / rows.length) : 0,
    agencyRate: AGENCY_RATE,
    agencyShare: Math.round(total * AGENCY_RATE),
    couriers: Array.from(byCourier.values()).sort((a, b) => b.earned - a.earned),
  };
}
