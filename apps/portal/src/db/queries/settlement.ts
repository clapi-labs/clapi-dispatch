import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

/**
 * El cierre del día, desde los viajes entregados. Tres números que el dueño
 * de la agencia necesita y que hoy saca a mano de un cuaderno:
 *
 * - **Ganancia neta**: la suma de los domicilios (`deliveryFee`) — lo que la
 *   agencia cobra por llevar. El valor del pedido es del restaurante, no suyo.
 * - **Por método**: del dinero de los pedidos, cuánto entró por
 *   transferencia y cuánto anda en efectivo en la calle.
 * - **Por moto**: viajes, ganancia que generó y efectivo que debe entregar
 *   en base.
 */
export type SettlementRow = {
  courierId: number;
  courierName: string;
  deliveredCount: number;
  netEarnings: number;
  cashToDeliver: number;
};

export type Settlement = {
  netEarnings: number;
  deliveredCount: number;
  averageFee: number;
  byMethod: {
    cash: { orders: number; amount: number };
    transfer: { orders: number; amount: number };
  };
  couriers: SettlementRow[];
};

export async function getSettlement(): Promise<Settlement> {
  const rows = await db
    .select({
      courierId: schema.assignments.courierId,
      courierName: schema.assignments.courierName,
      paymentMethod: schema.trips.paymentMethod,
      valueToCollect: schema.trips.valueToCollect,
      deliveryFee: schema.trips.deliveryFee,
    })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(eq(schema.trips.status, "delivered"));

  const byCourier = new Map<string, SettlementRow>();
  const byMethod = { cash: { orders: 0, amount: 0 }, transfer: { orders: 0, amount: 0 } };
  let netEarnings = 0;

  for (const row of rows) {
    netEarnings += row.deliveryFee;
    const method = row.paymentMethod === "efectivo" ? byMethod.cash : byMethod.transfer;
    method.orders += 1;
    method.amount += row.valueToCollect ?? 0;

    const entry = byCourier.get(row.courierName) ?? {
      courierId: row.courierId ?? 0,
      courierName: row.courierName,
      deliveredCount: 0,
      netEarnings: 0,
      cashToDeliver: 0,
    };
    entry.deliveredCount += 1;
    entry.netEarnings += row.deliveryFee;
    if (row.paymentMethod === "efectivo") entry.cashToDeliver += row.valueToCollect ?? 0;
    byCourier.set(row.courierName, entry);
  }

  return {
    netEarnings,
    deliveredCount: rows.length,
    averageFee: rows.length ? Math.round(netEarnings / rows.length) : 0,
    byMethod,
    couriers: Array.from(byCourier.values()).sort((a, b) => b.netEarnings - a.netEarnings),
  };
}
