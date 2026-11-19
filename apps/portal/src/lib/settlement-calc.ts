import type { Settlement, SettlementDay, SettlementRow } from "@/lib/types";
import { bogotaDate, weekRange } from "@/lib/week";

/** La parte de la agencia sobre lo que generan los domicilios. */
export const AGENCY_RATE = 0.1;

/** Un viaje entregado, lo mínimo para el cierre. */
export type DeliveredRow = {
  courierId: number | null;
  courierName: string;
  deliveryFee: number;
  deliveredAt: Date;
};

/** Total, promedio y parte de la agencia, por moto (de la que más generó a la que menos). */
export function summarize(rows: DeliveredRow[]): Settlement {
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

/** Lunes a domingo de la semana de `ymd`: viajes, total y parte de la agencia de cada día (los días sin entregas, en cero). */
export function byDay(rows: DeliveredRow[], ymd: string): SettlementDay[] {
  const week = weekRange(ymd);
  const days: SettlementDay[] = week.days.map((d) => ({ date: d.date, deliveredCount: 0, total: 0, agencyShare: 0 }));
  const index = new Map(days.map((d, i) => [d.date, i]));
  for (const row of rows) {
    const i = index.get(bogotaDate(row.deliveredAt));
    if (i === undefined) continue; // fuera de la semana
    days[i].deliveredCount += 1;
    days[i].total += row.deliveryFee;
  }
  for (const d of days) d.agencyShare = Math.round(d.total * AGENCY_RATE);
  return days;
}

/** Los viajes de un día (hora de Colombia). */
export function onDay(rows: DeliveredRow[], day: string): DeliveredRow[] {
  return rows.filter((r) => bogotaDate(r.deliveredAt) === day);
}
