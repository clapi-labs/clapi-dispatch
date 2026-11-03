import { desc, eq, gte, inArray, or, sql } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

export type TripRow = typeof schema.trips.$inferSelect;
export type AssignmentRow = typeof schema.assignments.$inferSelect;

export type TripWithAssignment = TripRow & {
  courierName: string | null;
  courierId: number | null;
  courierPhone: string | null;
  assignedAt: Date | null;
  deliveredAt: Date | null;
};

/** Lo que el tablero necesita: los viajes abiertos (sin importar cuándo se
 *  crearon) y los que se movieron hoy, hora de Colombia — no toda la historia,
 *  que crece cada día y se pedía completa en cada actualización. El arqueo
 *  saca sus cifras aparte. Con el domiciliario asignado si lo hay: `leftJoin`
 *  porque un viaje recién creado todavía no tiene fila en `assignments`. El
 *  teléfono sale de `couriers`: la asignación solo guarda el nombre. */
export async function listTrips(): Promise<TripWithAssignment[]> {
  const rows = await db
    .select({
      trip: schema.trips,
      courierName: schema.assignments.courierName,
      courierId: schema.assignments.courierId,
      courierPhone: schema.couriers.phone,
      assignedAt: schema.assignments.assignedAt,
      deliveredAt: schema.assignments.deliveredAt,
    })
    .from(schema.trips)
    .leftJoin(schema.assignments, eq(schema.assignments.tripId, schema.trips.id))
    .leftJoin(schema.couriers, eq(schema.couriers.id, schema.assignments.courierId))
    .where(
      or(
        inArray(schema.trips.status, ["pending", "assigned", "en_route"]),
        gte(schema.trips.updatedAt, sql`date_trunc('day', now() at time zone 'America/Bogota') at time zone 'America/Bogota'`),
      ),
    )
    .orderBy(desc(schema.trips.createdAt));

  return rows.map((r) => ({
    ...r.trip,
    courierName: r.courierName,
    courierId: r.courierId,
    courierPhone: r.courierPhone,
    assignedAt: r.assignedAt,
    deliveredAt: r.deliveredAt,
  }));
}

export async function setTripStatus(tripId: number, status: schema.TripStatus) {
  await db.update(schema.trips).set({ status, updatedAt: new Date() }).where(eq(schema.trips.id, tripId));
}

export async function markDelivered(tripId: number) {
  await db
    .update(schema.trips)
    .set({ status: "delivered", updatedAt: new Date() })
    .where(eq(schema.trips.id, tripId));
  await db.update(schema.assignments).set({ deliveredAt: new Date() }).where(eq(schema.assignments.tripId, tripId));
}
