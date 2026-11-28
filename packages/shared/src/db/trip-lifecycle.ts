/**
 * El ciclo de vida del viaje: asignarlo a una moto (la que eligió el engine o la
 * central), devolverlo a despacho, entregarlo, cerrarlo sin entregar o
 * cancelarlo. Quién
 * elige la moto en automático es el engine (`apps/bot/src/dispatch/engine.ts`);
 * aquí solo viven las mutaciones.
 *
 * Vive en `shared` porque la usan dos sitios que tienen que coincidir: el bot y
 * el portal. Los "reclamos" son `UPDATE … WHERE estado = X RETURNING`: si dos
 * procesos intentan lo mismo a la vez, solo uno gana la fila.
 */
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";

import { CANCEL_REQUEST_REASON_PREFIX } from "../domain/cancel-request";
import type { DeliveryPlace, RouteStop } from "../domain/phase";
import { db } from "./client";
import { assignments, conversations, courierRoutes, couriers, engineEvaluations, trips } from "./schema";
import { assignableByHand, dispatchableCourier } from "./simulator-flag";

/** Para una consulta con `trips`: lo que el motorizado todavía tiene encima.
 *  El servicio termina al entregar: lo que deba volver a llevar al restaurante
 *  es un pendiente aparte (`return_debts`), que no lo deja ocupado. */
export const openTripCondition = () => inArray(trips.status, ["assigned", "en_route"]);

/** Para una consulta con `trips`: solo los domicilios. Los encargos los
 *  coordina la central (db/errands.ts): el engine no los asigna ni los cuenta en
 *  la demanda, y no tienen recordatorios, GPS ni ruta. */
export const deliveryTripCondition = () => eq(trips.kind, "delivery");

/** Para una consulta con `trips`: un encargo. */
export const errandTripCondition = () => eq(trips.kind, "errand");

/** Reclama la moto, si sigue en uno de esos estados y entre las que `allowed`
 *  admite, y deja la asignación. */
async function bindCourier(tripId: number, courierId: number, from: ("available" | "busy")[], now: Date, allowed = dispatchableCourier()) {
  const [courier] = await db
    .update(couriers)
    .set({
      status: "busy",
      lastAssignedAt: now,
      deliveriesThisShift: sql`${couriers.deliveriesThisShift} + 1`,
    })
    .where(and(eq(couriers.id, courierId), eq(couriers.active, true), allowed, inArray(couriers.status, from)))
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
 *
 * `byHand`: lo asigna la central. En staging, eso incluye las motos reales con
 * GPS (viaje de prueba), que el despacho automático nunca elige.
 */
export async function assignTripTo(
  tripId: number,
  courierId: number,
  { byHand = false }: { byHand?: boolean } = {},
): Promise<{ courierId: number; courierName: string } | null> {
  const now = new Date();
  const [claimedTrip] = await db
    .update(trips)
    .set({ status: "en_route", updatedAt: now })
    .where(and(eq(trips.id, tripId), eq(trips.status, "pending")))
    .returning({ id: trips.id });
  if (!claimedTrip) return null;

  const courier = await bindCourier(tripId, courierId, ["available", "busy"], now, byHand ? assignableByHand() : dispatchableCourier());
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

/** El cliente nunca contestó y el pedido ya está de vuelta: el viaje se cancela.
 *  La moto ya había salido con el pedido, así que se cobra el domicilio
 *  (`domain/trip-cancel.ts`). */
export async function closeUndeliveredTrip(tripId: number): Promise<boolean> {
  const now = new Date();
  const [trip] = await db
    .update(trips)
    .set({ status: "cancelled", cancelledAt: now, cancelReason: "El cliente no contestó", cancelFee: sql`nullif(${trips.deliveryFee}, 0)`, updatedAt: now })
    .where(and(eq(trips.id, tripId), eq(trips.status, "en_route")))
    .returning({ id: trips.id });
  if (!trip) return false;
  const [assignment] = await db.update(assignments).set({ finishedAt: now }).where(eq(assignments.tripId, tripId)).returning({ courierId: assignments.courierId });
  if (assignment?.courierId) await releaseCourier(assignment.courierId);
  return true;
}

export type CancelledTrip = {
  code: string;
  kind: "delivery" | "errand";
  /** La moto que lo llevaba, para avisarle; nula si seguía sin moto. */
  courierId: number | null;
  pickedUp: boolean;
  /** Lo que se cobra del domicilio; nulo si no se cobra. */
  charged: number | null;
};

/**
 * La central cancela un viaje que sigue abierto (sin moto, asignado o en la
 * calle). Queda el motivo, la hora y lo que se cobra: con `charge` se cobra el
 * domicilio completo, pero solo si alguna moto lo llevaba (sin moto no hay quién
 * lo cobre). La moto queda libre y, si no lo había recogido, ese viaje no le
 * cuenta en el turno. Si el restaurante había pedido cancelarlo por el chat, el
 * chat vuelve al bot. `null` si ya no estaba abierto (otro lo entregó o lo
 * canceló antes).
 */
export async function cancelTrip(tripId: number, { reason, charge }: { reason: string; charge: boolean }): Promise<CancelledTrip | null> {
  const now = new Date();
  const [assignment] = await db.select().from(assignments).where(eq(assignments.tripId, tripId)).limit(1);
  const fee = charge && assignment?.courierId ? sql`nullif(${trips.deliveryFee}, 0)` : null;
  const [trip] = await db
    .update(trips)
    .set({ status: "cancelled", cancelledAt: now, cancelReason: reason.trim() || null, cancelFee: fee, updatedAt: now })
    .where(and(eq(trips.id, tripId), inArray(trips.status, ["pending", "assigned", "en_route"])))
    .returning({ code: trips.code, kind: trips.kind, cancelFee: trips.cancelFee, conversationId: trips.conversationId });
  if (!trip) return null;

  await db.delete(engineEvaluations).where(eq(engineEvaluations.tripId, tripId));
  const courierId = assignment?.courierId ?? null;
  const pickedUp = !!assignment?.pickedUpAt;
  if (assignment) {
    await db.update(assignments).set({ finishedAt: now }).where(eq(assignments.tripId, tripId));
    if (courierId && !pickedUp) {
      await db
        .update(couriers)
        .set({ deliveriesThisShift: sql`greatest(${couriers.deliveriesThisShift} - 1, 0)` })
        .where(eq(couriers.id, courierId));
    }
    if (courierId) await releaseCourier(courierId);
  }

  // Ya se hizo lo que pidió: el chat no se queda esperando a la central.
  if (trip.conversationId) {
    await db
      .update(conversations)
      .set({ botPaused: false, escalationReason: null, failedAttempts: 0 })
      .where(
        and(
          eq(conversations.id, trip.conversationId),
          eq(conversations.botPaused, true),
          like(conversations.escalationReason, `${CANCEL_REQUEST_REASON_PREFIX}%`),
          like(conversations.escalationReason, `%${trip.code}%`),
        ),
      );
  }

  return { code: trip.code, kind: trip.kind, courierId, pickedUp, charged: trip.cancelFee };
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
 * La entrega: el viaje pasa a entregado con la hora real y el lugar, y el
 * servicio termina ahí. Si no lleva nada más queda libre; los pendientes los
 * asigna el engine en el siguiente tick. Un pendiente de regreso (el datáfono,
 * la plata) no lo deja ocupado. `false` si el viaje ya no estaba en ruta (un
 * doble toque, o el portal y el motorizado marcándolo a la vez): no es un
 * error, ya se hizo.
 */
export async function deliverTrip(tripId: number, { place }: { place: DeliveryPlace }): Promise<boolean> {
  const now = new Date();

  const [trip] = await db
    .update(trips)
    .set({ status: "delivered", updatedAt: now })
    .where(and(eq(trips.id, tripId), eq(trips.status, "en_route")))
    .returning({ id: trips.id });
  if (!trip) return false;

  const [assignment] = await db
    .update(assignments)
    .set({ deliveredAt: now, deliveryPlace: place, finishedAt: now })
    .where(eq(assignments.tripId, tripId))
    .returning({ courierId: assignments.courierId });

  if (assignment?.courierId) await releaseCourier(assignment.courierId);
  return true;
}
