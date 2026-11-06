import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { DeliveryPlace, RouteStop } from "../domain/phase";
import { db } from "./client";
import { getEngineConfig } from "./engine-config";
import { assignments, courierRoutes, couriers, engineEvaluations, trips } from "./schema";

/** Para una consulta con `trips` y `assignments`: lo que el motorizado todavía
 *  tiene encima, incluido un viaje entregado del que está volviendo. */
export const openTripCondition = () =>
  or(
    inArray(trips.status, ["assigned", "en_route"]),
    and(eq(trips.status, "delivered"), isNotNull(assignments.returnStartedAt), isNull(assignments.finishedAt)),
  );

/**
 * Asignación por cola (round-robin): mientras el engine no esté al frente
 * (`settings.engine_config.mode`), el viaje va al motorizado libre que lleva más
 * tiempo sin recibir uno. Al terminar el servicio vuelve al final de la cola.
 *
 * Vive en `shared` porque la usan dos sitios que tienen que coincidir: el bot
 * (asigna en cuanto el pedido queda completo) y el portal (reintenta los
 * pendientes cuando se libera una moto).
 *
 * Las dos "reservas" son `UPDATE … WHERE estado = X RETURNING`: si el bot y
 * el portal intentan asignar al mismo tiempo, solo uno gana la fila y el otro
 * no hace nada, en vez de mandar dos motos o darle dos viajes a una.
 */
export async function assignNextCourier(tripId: number): Promise<{ courierId: number; courierName: string } | null> {
  const now = new Date();

  const [claimedTrip] = await db
    .update(trips)
    .set({ status: "en_route", updatedAt: now })
    .where(and(eq(trips.id, tripId), eq(trips.status, "pending")))
    .returning({ id: trips.id });
  if (!claimedTrip) return null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const [candidate] = await db
      .select({ id: couriers.id })
      .from(couriers)
      .where(and(eq(couriers.status, "available"), eq(couriers.active, true)))
      .orderBy(sql`${couriers.lastAssignedAt} asc nulls first`, asc(couriers.id))
      .limit(1);

    if (!candidate) break;

    const courier = await bindCourier(tripId, candidate.id, ["available"], now);
    if (courier) return { courierId: courier.id, courierName: courier.name };
    // otro proceso la tomó primero: probar con la siguiente
  }

  // Ninguna moto libre: el viaje vuelve a esperar en "Por asignar".
  await db.update(trips).set({ status: "pending", updatedAt: now }).where(eq(trips.id, tripId));
  return null;
}

/** Reclama la moto, si sigue en uno de esos estados, y deja la asignación. */
async function bindCourier(tripId: number, courierId: number, from: ("available" | "busy")[], now: Date) {
  const [courier] = await db
    .update(couriers)
    .set({
      status: "busy",
      lastAssignedAt: now,
      deliveriesThisShift: sql`${couriers.deliveriesThisShift} + 1`,
    })
    .where(and(eq(couriers.id, courierId), eq(couriers.active, true), inArray(couriers.status, from)))
    .returning({ id: couriers.id, name: couriers.name });
  if (!courier) return null;

  await db
    .insert(assignments)
    .values({ tripId, courierId: courier.id, courierName: courier.name, assignedAt: now, dispatchedAt: now })
    .onConflictDoUpdate({
      target: assignments.tripId,
      // Moto nueva: el servicio empieza de cero para ella.
      set: {
        courierId: courier.id,
        courierName: courier.name,
        assignedAt: now,
        dispatchedAt: now,
        readAt: null,
        seenAt: null,
        seenReminderAt: null,
        startDistanceM: null,
        atPickupAt: null,
        pickedUpAt: null,
        pickupReminderAt: null,
        atDeliveryAt: null,
        leftDeliveryAt: null,
        customerWaitAt: null,
        undeliveredAt: null,
        deliveredAt: null,
        deliveryPlace: null,
        returnStartedAt: null,
        finishedAt: null,
      },
    });
  return courier;
}

/**
 * Asigna a una moto concreta: la que eligió el engine o la central. Puede estar
 * libre u ocupada, porque la idea es que las motos no queden quietas: el engine
 * ya midió si le cabe. `null` si el viaje ya no estaba pendiente o la moto ya no
 * está disponible; el viaje sigue pendiente.
 */
export async function assignTripTo(tripId: number, courierId: number): Promise<{ courierId: number; courierName: string } | null> {
  const now = new Date();
  const [claimedTrip] = await db
    .update(trips)
    .set({ status: "en_route", updatedAt: now })
    .where(and(eq(trips.id, tripId), eq(trips.status, "pending")))
    .returning({ id: trips.id });
  if (!claimedTrip) return null;

  const courier = await bindCourier(tripId, courierId, ["available", "busy"], now);
  if (courier) return { courierId: courier.id, courierName: courier.name };

  await db.update(trips).set({ status: "pending", updatedAt: now }).where(eq(trips.id, tripId));
  return null;
}

/** El orden de paradas que dejó la última asignación de la moto. */
export async function saveCourierRoute(courierId: number, stops: RouteStop[]) {
  const now = new Date();
  await db
    .insert(courierRoutes)
    .values({ courierId, stops, updatedAt: now })
    .onConflictDoUpdate({ target: courierRoutes.courierId, set: { stops, updatedAt: now } });
}

/**
 * Le quita el viaje a la moto para que se asigne de nuevo, solo si todavía no
 * lo recogió: con el pedido en la mano, eso lo decide una persona. Devuelve la
 * moto que lo tenía, para avisarle; `null` si ya no se podía.
 */
export async function returnTripToDispatch(tripId: number): Promise<{ courierId: number | null } | null> {
  const [removed] = await db
    .delete(assignments)
    .where(and(eq(assignments.tripId, tripId), isNull(assignments.pickedUpAt), isNull(assignments.deliveredAt)))
    .returning({ courierId: assignments.courierId });
  if (!removed) return null;

  await db.update(trips).set({ status: "pending", updatedAt: new Date() }).where(and(eq(trips.id, tripId), eq(trips.status, "en_route")));
  // Lo que había decidido el engine ya no vale: que evalúe de nuevo.
  await db.delete(engineEvaluations).where(eq(engineEvaluations.tripId, tripId));

  if (removed.courierId) {
    await db
      .update(couriers)
      .set({ deliveriesThisShift: sql`greatest(${couriers.deliveriesThisShift} - 1, 0)` })
      .where(eq(couriers.id, removed.courierId));
    await releaseCourier(removed.courierId);
  }
  return removed;
}

/** La moto se desconecta: lo que no ha recogido se asigna de nuevo y termina lo
 *  que ya lleva. Devuelve los viajes que le quitó. */
export async function returnUnpickedTrips(courierId: number): Promise<number[]> {
  const rows = await db
    .select({ tripId: assignments.tripId })
    .from(assignments)
    .innerJoin(trips, eq(trips.id, assignments.tripId))
    .where(and(eq(assignments.courierId, courierId), inArray(trips.status, ["assigned", "en_route"]), isNull(assignments.pickedUpAt)));
  const returned: number[] = [];
  for (const { tripId } of rows) if (await returnTripToDispatch(tripId)) returned.push(tripId);
  return returned;
}

/** El cliente nunca contestó y el pedido ya está de vuelta: el viaje se cancela. */
export async function closeUndeliveredTrip(tripId: number): Promise<boolean> {
  const now = new Date();
  const [trip] = await db
    .update(trips)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(trips.id, tripId), eq(trips.status, "en_route")))
    .returning({ id: trips.id });
  if (!trip) return false;
  const [assignment] = await db.update(assignments).set({ finishedAt: now }).where(eq(assignments.tripId, tripId)).returning({ courierId: assignments.courierId });
  if (assignment?.courierId) await releaseCourier(assignment.courierId);
  return true;
}

/** Asigna los pendientes, el más viejo primero, hasta quedarse sin motos.
 *  Devuelve los ids de los viajes que acaban de recibir moto: quien llama
 *  tiene que avisarle al motorizado y al restaurante. */
export async function assignPendingTrips(): Promise<number[]> {
  // Con el engine al frente, la cola no asigna nada (apps/bot/src/dispatch/engine.ts).
  if ((await getEngineConfig()).mode === "auto") return [];

  const pending = await db
    .select({ id: trips.id })
    .from(trips)
    .where(eq(trips.status, "pending"))
    .orderBy(asc(trips.createdAt));

  const assigned: number[] = [];
  for (const trip of pending) {
    const result = await assignNextCourier(trip.id);
    if (!result) break;
    assigned.push(trip.id);
  }
  return assigned;
}

/** Queda libre, salvo que todavía lleve algo o esté en emergencia. */
async function releaseCourier(courierId: number) {
  const [other] = await db
    .select({ id: trips.id })
    .from(assignments)
    .innerJoin(trips, eq(trips.id, assignments.tripId))
    .where(and(eq(assignments.courierId, courierId), openTripCondition()))
    .limit(1);
  if (other) return;

  await db
    .update(couriers)
    .set({ status: "available" })
    .where(and(eq(couriers.id, courierId), eq(couriers.status, "busy")));
}

/**
 * La entrega: el viaje pasa a entregado con la hora real y el lugar. Si debe
 * volver a recogida (`returning`), sigue ocupado hasta `finishTrip`; si no,
 * queda libre y toma el siguiente pendiente. `null` si el viaje ya no estaba
 * en ruta (un doble toque, o el portal y el motorizado marcándolo a la vez):
 * no es un error, ya se hizo.
 */
export async function deliverTrip(
  tripId: number,
  { place, returning }: { place: DeliveryPlace; returning: boolean },
): Promise<{ newlyAssigned: number[] } | null> {
  const now = new Date();

  const [trip] = await db
    .update(trips)
    .set({ status: "delivered", updatedAt: now })
    .where(and(eq(trips.id, tripId), eq(trips.status, "en_route")))
    .returning({ id: trips.id });
  if (!trip) return null;

  const [assignment] = await db
    .update(assignments)
    .set({ deliveredAt: now, deliveryPlace: place, ...(returning ? { returnStartedAt: now } : { finishedAt: now }) })
    .where(eq(assignments.tripId, tripId))
    .returning({ courierId: assignments.courierId });

  if (returning) return { newlyAssigned: [] };
  if (assignment?.courierId) await releaseCourier(assignment.courierId);
  return { newlyAssigned: await assignPendingTrips() };
}

/** «Ya volví»: termina el servicio de quien estaba de regreso. `null` si no
 *  estaba volviendo o ya había terminado. */
export async function finishTrip(tripId: number): Promise<{ newlyAssigned: number[] } | null> {
  const [assignment] = await db
    .update(assignments)
    .set({ finishedAt: new Date() })
    .where(and(eq(assignments.tripId, tripId), isNotNull(assignments.returnStartedAt), isNull(assignments.finishedAt)))
    .returning({ courierId: assignments.courierId });
  if (!assignment) return null;

  if (assignment.courierId) await releaseCourier(assignment.courierId);
  return { newlyAssigned: await assignPendingTrips() };
}
