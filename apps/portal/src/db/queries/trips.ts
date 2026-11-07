import { desc, eq, gte, or, sql } from "drizzle-orm";

import { db, getBotConfig, getEngineConfig, openTripCondition, routeKm, schema } from "@dispatch/shared/db";
import { isTripOpen, orderStops, phaseAlertAt, stopsForPhase, tripPhase, type DeliveryPlace, type RouteStop } from "@dispatch/shared";

export type TripRow = typeof schema.trips.$inferSelect;
export type AssignmentRow = typeof schema.assignments.$inferSelect;

export type TripWithAssignment = TripRow & {
  courierName: string | null;
  courierId: number | null;
  courierPhone: string | null;
  assignedAt: Date | null;
  deliveredAt: Date | null;
  /** Kilómetros del domicilio; nulo si falta alguna de las dos ubicaciones. */
  distanceKm: number | null;
  /** Cuándo WhatsApp avisó que leyó el mensaje. */
  readAt: Date | null;
  /** Cuándo el motorizado tocó «Voy en camino». */
  seenAt: Date | null;
  /** Cuándo se le recordó «Voy en camino». */
  seenReminderAt: Date | null;
  /** Cuándo el GPS lo vio llegar a la recogida. */
  atPickupAt: Date | null;
  /** Cuándo tocó «Recogí», o cuándo el GPS lo vio salir de la recogida. */
  pickedUpAt: Date | null;
  /** Cuándo el GPS lo vio llegar a la entrega, y salir sin haberla marcado. */
  atDeliveryAt: Date | null;
  leftDeliveryAt: Date | null;
  /** Avisó que el cliente no contesta, y cuándo pasó a devolver el pedido. */
  customerWaitAt: Date | null;
  undeliveredAt: Date | null;
  /** Cuándo se le recordó que ya estaba listo. */
  pickupReminderAt: Date | null;
  deliveryPlace: DeliveryPlace | null;
  /** Entregó y está volviendo a recogida. */
  returnStartedAt: Date | null;
  finishedAt: Date | null;
  /** Desde cuándo sale en rojo si sigue en esa fase. `null` si no hay nada que
   *  vigilar. */
  alertAt: Date | null;
  /** Con el engine asignando: por qué sigue pendiente, y cuándo se despacha. */
  dispatchNote: string | null;
  dispatchAt: Date | null;
};

/** Lo que el tablero necesita: los viajes abiertos (sin importar cuándo se
 *  crearon) y los que se movieron hoy, hora de Colombia — no toda la historia,
 *  que crece cada día y se pedía completa en cada actualización. El arqueo
 *  saca sus cifras aparte. Con el domiciliario asignado si lo hay: `leftJoin`
 *  porque un viaje recién creado todavía no tiene fila en `assignments`. El
 *  teléfono sale de `couriers`: la asignación solo guarda el nombre. */
export async function listTrips(): Promise<TripWithAssignment[]> {
  const [config, { mode }, routes] = await Promise.all([getBotConfig(), getEngineConfig(), db.select().from(schema.courierRoutes)]);
  const rows = await db
    .select({
      trip: schema.trips,
      courierName: schema.assignments.courierName,
      courierId: schema.assignments.courierId,
      courierPhone: schema.couriers.phone,
      assignedAt: schema.assignments.assignedAt,
      deliveredAt: schema.assignments.deliveredAt,
      readAt: schema.assignments.readAt,
      seenAt: schema.assignments.seenAt,
      seenReminderAt: schema.assignments.seenReminderAt,
      atPickupAt: schema.assignments.atPickupAt,
      pickedUpAt: schema.assignments.pickedUpAt,
      atDeliveryAt: schema.assignments.atDeliveryAt,
      leftDeliveryAt: schema.assignments.leftDeliveryAt,
      customerWaitAt: schema.assignments.customerWaitAt,
      undeliveredAt: schema.assignments.undeliveredAt,
      pickupReminderAt: schema.assignments.pickupReminderAt,
      deliveryPlace: schema.assignments.deliveryPlace,
      returnStartedAt: schema.assignments.returnStartedAt,
      finishedAt: schema.assignments.finishedAt,
      engineReason: schema.engineEvaluations.reason,
      engineDispatchAt: schema.engineEvaluations.dispatchAt,
    })
    .from(schema.trips)
    .leftJoin(schema.assignments, eq(schema.assignments.tripId, schema.trips.id))
    .leftJoin(schema.couriers, eq(schema.couriers.id, schema.assignments.courierId))
    .leftJoin(schema.engineEvaluations, eq(schema.engineEvaluations.tripId, schema.trips.id))
    .where(
      or(
        eq(schema.trips.status, "pending"),
        openTripCondition(),
        gte(schema.trips.updatedAt, sql`date_trunc('day', now() at time zone 'America/Bogota') at time zone 'America/Bogota'`),
      ),
    )
    .orderBy(desc(schema.trips.createdAt));

  // La primera parada de cada moto: si un pedido no es el que sigue, no ir a
  // recogerlo todavía no es una demora.
  const plans = new Map<number, RouteStop[]>(routes.map((r) => [r.courierId, r.stops]));
  const next = new Map<number, number | undefined>();
  const open = rows.filter((r) => r.courierId !== null && isTripOpen({ ...r, status: r.trip.status }));
  for (const courierId of new Set(open.map((r) => r.courierId!))) {
    const mine = open
      .filter((r) => r.courierId === courierId)
      .map((r) => ({ id: r.trip.id, stops: stopsForPhase(tripPhase({ ...r, status: r.trip.status }), false) }));
    next.set(courierId, orderStops(plans.get(courierId), mine)[0]?.pedido);
  }

  return rows.map((r) => ({
    ...r.trip,
    courierName: r.courierName,
    courierId: r.courierId,
    courierPhone: r.courierPhone,
    assignedAt: r.assignedAt,
    deliveredAt: r.deliveredAt,
    distanceKm: r.trip.pickupLocation && r.trip.deliveryLocation ? routeKm(r.trip.pickupLocation, r.trip.deliveryLocation) : null,
    readAt: r.readAt,
    seenAt: r.seenAt,
    seenReminderAt: r.seenReminderAt,
    atPickupAt: r.atPickupAt,
    pickedUpAt: r.pickedUpAt,
    atDeliveryAt: r.atDeliveryAt,
    leftDeliveryAt: r.leftDeliveryAt,
    customerWaitAt: r.customerWaitAt,
    undeliveredAt: r.undeliveredAt,
    pickupReminderAt: r.pickupReminderAt,
    deliveryPlace: r.deliveryPlace,
    returnStartedAt: r.returnStartedAt,
    finishedAt: r.finishedAt,
    alertAt: r.assignedAt ? phaseAlertAt({ ...r, status: r.trip.status, readyAt: r.trip.readyAt }, config, { notNext: next.get(r.courierId ?? 0) !== r.trip.id }) : null,
    dispatchNote: mode === "auto" && r.trip.status === "pending" ? r.engineReason : null,
    dispatchAt: mode === "auto" && r.trip.status === "pending" ? r.engineDispatchAt : null,
  }));
}
