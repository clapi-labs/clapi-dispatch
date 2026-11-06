import { and, eq, isNull, lt, or } from "drizzle-orm";

import { db, finishTrip, getBotConfig, openTripCondition, schema, type BotConfig } from "@dispatch/shared/db";
import { haversineKm, isBeforePickup, tripPhase } from "@dispatch/shared";

import { notifyAssigned, notifyFinished, notifyPicked } from "@/bot/notify";

/**
 * Lo que dice la ubicación (docs/FLUJO-DOMICILIARIO.md, fase 5). Marca los estados
 * que se pueden saber con solo verlo moverse: que salió, que llegó, que se fue y
 * que volvió. La entrega no: llegar no prueba que se entregó, ni dice si quedó en
 * portería. Por eso se queda el botón, y si se va sin marcarla sale la alerta.
 *
 * Cada marca es un UPDATE condicional: dos reportes seguidos no la repiten.
 */

/** Salir exige alejarse un poco más de lo que se pide para llegar: así el rebote
 *  del GPS en el borde del punto no cuenta como llegar y salir. */
const LEAVE_FACTOR = 1.5;
/** Con menos de esto de anticipación, ya se la pudo llevar. */
const READY_MARGIN_MS = 2 * 60_000;

type Point = { lat: number; lng: number };

const meters = (a: Point, b: Point) => haversineKm(a, b) * 1000;

export async function courierForDevice(deviceId: string) {
  const [row] = await db
    .select({ courier: schema.couriers })
    .from(schema.courierProfiles)
    .innerJoin(schema.couriers, eq(schema.couriers.id, schema.courierProfiles.courierId))
    .where(and(eq(schema.courierProfiles.gpsDeviceId, deviceId), eq(schema.couriers.active, true)))
    .limit(1);
  return row?.courier ?? null;
}

/** Guarda la posición y revisa qué cambió en lo que lleva. Un reporte más viejo
 *  que el último (el celular estuvo sin señal y se pone al día) solo se ignora. */
export async function recordPosition(courierId: number, position: Point, at: Date) {
  const [updated] = await db
    .update(schema.couriers)
    .set({ lat: position.lat, lng: position.lng, locationUpdatedAt: at })
    .where(and(eq(schema.couriers.id, courierId), or(isNull(schema.couriers.locationUpdatedAt), lt(schema.couriers.locationUpdatedAt, at))))
    .returning({ id: schema.couriers.id });
  if (!updated) return;

  const [config, rows] = await Promise.all([
    getBotConfig(),
    db
      .select({ trip: schema.trips, assignment: schema.assignments })
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(and(eq(schema.assignments.courierId, courierId), openTripCondition())),
  ]);
  for (const { trip, assignment } of rows) await checkTrip(trip, assignment, position, at, config);
}

type Trip = typeof schema.trips.$inferSelect;
type Assignment = typeof schema.assignments.$inferSelect;

function update(tripId: number, values: Partial<typeof schema.assignments.$inferInsert>, ...conditions: Parameters<typeof and>) {
  return db
    .update(schema.assignments)
    .set(values)
    .where(and(eq(schema.assignments.tripId, tripId), ...conditions))
    .returning({ tripId: schema.assignments.tripId });
}

async function checkTrip(trip: Trip, a: Assignment, position: Point, at: Date, config: BotConfig) {
  const phase = tripPhase({ ...a, status: trip.status });
  const arrived = config.gpsArrivalMeters;
  const left = arrived * LEAVE_FACTOR;
  const stayed = (since: Date | null) => since !== null && at.getTime() - since.getTime() >= config.gpsDwellSeconds * 1000;

  if (isBeforePickup(phase) && trip.pickupLocation) {
    const distance = meters(position, trip.pickupLocation);
    if (a.startDistanceM === null) await update(trip.id, { startDistanceM: distance }, isNull(schema.assignments.startDistanceM));
    else if (!a.seenAt && distance <= a.startDistanceM - config.gpsDepartureMeters) await update(trip.id, { seenAt: at }, isNull(schema.assignments.seenAt));

    if (distance <= arrived) {
      if (!a.atPickupAt) await update(trip.id, { atPickupAt: at }, isNull(schema.assignments.atPickupAt));
    } else if (a.atPickupAt && distance > left) {
      // Se fue: si estuvo un rato y la comida ya podía estar lista, se la llevó y
      // necesita la dirección. Si no, solo pasó por ahí.
      const ready = !trip.readyAt || at.getTime() >= trip.readyAt.getTime() - READY_MARGIN_MS;
      if (stayed(a.atPickupAt) && ready) {
        const [marked] = await update(trip.id, { pickedUpAt: at }, isNull(schema.assignments.pickedUpAt));
        if (marked) await notifyPicked(trip.id);
      } else {
        await update(trip.id, { atPickupAt: null });
      }
    }
    return;
  }

  if ((phase === "carrying" || phase === "at_delivery") && trip.deliveryLocation) {
    const distance = meters(position, trip.deliveryLocation);
    if (distance <= arrived) {
      // Volvió al punto: la alerta de que se había ido ya no aplica.
      if (!a.atDeliveryAt || a.leftDeliveryAt) await update(trip.id, { atDeliveryAt: a.atDeliveryAt ?? at, leftDeliveryAt: null });
    } else if (a.atDeliveryAt && !a.leftDeliveryAt && distance > left) {
      if (stayed(a.atDeliveryAt)) await update(trip.id, { leftDeliveryAt: at }, isNull(schema.assignments.leftDeliveryAt));
      else await update(trip.id, { atDeliveryAt: null });
    }
    return;
  }

  if (phase === "returning" && trip.pickupLocation && meters(position, trip.pickupLocation) <= arrived) {
    const result = await finishTrip(trip.id);
    if (!result) return;
    await notifyFinished(trip.id, result.newlyAssigned);
    for (const id of result.newlyAssigned) await notifyAssigned(id);
  }
}
