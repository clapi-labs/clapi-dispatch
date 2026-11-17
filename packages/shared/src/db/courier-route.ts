import { and, eq, inArray, isNull } from "drizzle-orm";

import type { DemandLevel } from "../domain/demand";
import { stopsForPhase, tripPhase, type RouteStop, type StopKind, type TripPhase } from "../domain/phase";
import { debtGroupKey, groupDebts, joinCodes } from "../domain/return-debts";
import { orderRoute, routeText, type RouteLine, type ReturnStop } from "../domain/route";
import { db } from "./client";
import { getDemandLevel } from "./demand";
import { openTripCondition } from "./trip-lifecycle";
import { assignments, courierRoutes, restaurants, returnDebts, trips } from "./schema";

/**
 * La ruta de cada domiciliario con sus regresos (domain/route.ts): la usan el
 * engine para armar las paradas, los mensajes al domiciliario, Flota y el
 * simulador, así que todos ven el mismo orden.
 */

type LatLng = { lat: number; lng: number };

/** Un regreso con lo que hace falta para ir: a dónde y por qué pedidos. */
export type ReturnStopView = ReturnStop & {
  courierId: number;
  /** Todos los pendientes abiertos del grupo; se cierran juntos. */
  debtIds: number[];
  tripIds: number[];
  /** «A-07 y A-08». */
  codes: string;
  /** El restaurante registrado o, si no, la recogida de su pedido. `null`: no
   *  se sabe dónde queda y no entra en la ruta. */
  location: LatLng | null;
};

/** Los regresos abiertos de esos domiciliarios, agrupados por restaurante y motivo. */
export async function openReturnStops(courierIds: number[]): Promise<Map<number, ReturnStopView[]>> {
  const result = new Map<number, ReturnStopView[]>();
  if (!courierIds.length) return result;
  const rows = await db
    .select({
      id: returnDebts.id,
      courierId: returnDebts.courierId,
      restaurantId: returnDebts.restaurantId,
      restaurantName: returnDebts.restaurantName,
      reason: returnDebts.reason,
      tripId: returnDebts.tripId,
      tripCode: trips.code,
      createdAt: returnDebts.createdAt,
      routedAt: returnDebts.routedAt,
      known: restaurants.knownPickupLocation,
      pickup: trips.pickupLocation,
    })
    .from(returnDebts)
    .leftJoin(restaurants, eq(restaurants.id, returnDebts.restaurantId))
    .leftJoin(trips, eq(trips.id, returnDebts.tripId))
    .where(and(isNull(returnDebts.resolvedAt), inArray(returnDebts.courierId, courierIds)));

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const group of groupDebts(rows.map((r) => ({ ...r, deliveredAt: null })))) {
    const members = group.debts.map((d) => byId.get(d.id)!);
    const stop: ReturnStopView = {
      id: group.debts[0].id,
      courierId: group.courierId,
      reason: group.reason,
      restaurantId: group.restaurantId,
      restaurantName: group.restaurantName,
      inRoute: group.reason === "datafono" || members.some((m) => m.routedAt !== null),
      debtIds: members.map((m) => m.id),
      tripIds: members.flatMap((m) => (m.tripId === null ? [] : [m.tripId])),
      codes: joinCodes(members.map((m) => m.tripCode)),
      location: members.find((m) => m.known)?.known ?? members.find((m) => m.pickup)?.pickup ?? null,
    };
    result.set(stop.courierId, [...(result.get(stop.courierId) ?? []), stop]);
  }
  return result;
}

/**
 * La plata entra en la ruta: la de ese grupo que todavía no estaba. Se reclama
 * con un UPDATE condicional, así que dos ticks a la vez no la mandan dos veces.
 * Devuelve los que acaba de meter.
 */
export async function routeReturnDebts(debtIds: number[]): Promise<number[]> {
  if (!debtIds.length) return [];
  const rows = await db
    .update(returnDebts)
    .set({ routedAt: new Date() })
    .where(and(inArray(returnDebts.id, debtIds), isNull(returnDebts.routedAt), isNull(returnDebts.resolvedAt)))
    .returning({ id: returnDebts.id });
  return rows.map((r) => r.id);
}

/** Los pendientes del mismo grupo que uno de ellos (el `pedido` de una parada `B`). */
export async function returnGroupDebtIds(debtId: number): Promise<number[]> {
  const [debt] = await db.select().from(returnDebts).where(eq(returnDebts.id, debtId)).limit(1);
  if (!debt || debt.resolvedAt) return [];
  const open = await db
    .select()
    .from(returnDebts)
    .where(and(eq(returnDebts.courierId, debt.courierId), isNull(returnDebts.resolvedAt)));
  const key = debtGroupKey(debt);
  return open.filter((d) => debtGroupKey(d) === key).map((d) => d.id);
}

/** Una parada de la ruta, con lo que hace falta para mostrarla y para ir. */
export type CourierRouteStop = RouteStop & {
  line: RouteLine;
  point: LatLng | null;
};

type OpenTripRow = { trip: typeof trips.$inferSelect; phase: TripPhase };

/**
 * La ruta de cada domiciliario: sus pedidos abiertos y sus regresos, en el
 * orden de su último plan, con los regresos nuevos donde corresponden a la
 * demanda de ahora.
 */
export async function courierRoutesFor(courierIds: number[], level?: DemandLevel): Promise<Map<number, CourierRouteStop[]>> {
  const result = new Map<number, CourierRouteStop[]>();
  if (!courierIds.length) return result;
  const [rows, saved, returns, demand] = await Promise.all([
    db
      .select({ trip: trips, assignment: assignments })
      .from(assignments)
      .innerJoin(trips, eq(trips.id, assignments.tripId))
      .where(and(inArray(assignments.courierId, courierIds), openTripCondition()))
      .orderBy(assignments.assignedAt),
    db.select().from(courierRoutes).where(inArray(courierRoutes.courierId, courierIds)),
    openReturnStops(courierIds),
    level ?? getDemandLevel(),
  ]);
  for (const courierId of courierIds) {
    const open: OpenTripRow[] = rows
      .filter((r) => r.assignment.courierId === courierId)
      .map((r) => ({ trip: r.trip, phase: tripPhase({ ...r.assignment, status: r.trip.status }) }));
    const plan = saved.find((s) => s.courierId === courierId)?.stops ?? null;
    result.set(courierId, buildCourierRoute(plan, open, (returns.get(courierId) ?? []).filter((r) => r.location), demand));
  }
  return result;
}

/** La de un domiciliario. */
export async function courierRoute(courierId: number): Promise<CourierRouteStop[]> {
  return (await courierRoutesFor([courierId])).get(courierId) ?? [];
}

/** «🧭 Tu ruta: …» para el principio de sus mensajes; `null` con menos de dos paradas. */
export async function courierRouteText(courierId: number): Promise<string | null> {
  return routeText((await courierRoute(courierId)).map((s) => s.line));
}

/** Pura: arma la ruta con lo ya cargado. */
export function buildCourierRoute(plan: RouteStop[] | null, open: OpenTripRow[], returns: ReturnStopView[], level: DemandLevel): CourierRouteStop[] {
  const order = orderRoute(
    plan,
    open.map((t) => ({ id: t.trip.id, stops: stopsForPhase(t.phase) as StopKind[] })),
    returns,
    level,
  );
  return order.flatMap((s): CourierRouteStop[] => {
    if (s.tipo === "B") {
      const r = returns.find((x) => x.id === s.pedido);
      return r ? [{ ...s, line: { tipo: "B", reason: r.reason, restaurant: r.restaurantName }, point: r.location }] : [];
    }
    const t = open.find((x) => x.trip.id === s.pedido)?.trip;
    if (!t) return [];
    const atCustomer = s.tipo === "C" || s.tipo === "W";
    return [
      {
        ...s,
        line: { tipo: s.tipo, code: t.code, restaurant: t.originRestaurantName, zone: t.deliveryZone },
        point: (atCustomer ? t.deliveryLocation : t.pickupLocation) ?? null,
      },
    ];
  });
}
