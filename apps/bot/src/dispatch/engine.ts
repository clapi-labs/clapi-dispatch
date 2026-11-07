import { and, asc, desc, eq, gt, inArray, isNull, max, or } from "drizzle-orm";

import { assignNextCourier, assignTripTo, db, dispatchableCourier, getBotConfig, getEngineConfig, openTripCondition, saveCourierRoute, schema, type EngineConfig } from "@dispatch/shared/db";
import { customerWaitEndsAt, tripPhase, type RouteStop } from "@dispatch/shared";

import { buildEvaluarRequest, type SnapshotCourier } from "@/dispatch/engine-request";
import { env } from "@/env";

/**
 * El engine (docs/ALGORITMO.md), según `settings.engine_config.mode`:
 *
 * - `shadow`: la cola sigue asignando y aquí se calcula al lado, en cada tick, a
 *   quién y cuándo habría asignado cada viaje. No toca la asignación real.
 * - `auto`: asigna de verdad, cuando le llega la hora a cada pedido. La cola no
 *   se usa. Si no hay GPS o el engine falla, el pedido sigue esperando con el
 *   motivo a la vista, y la central lo puede asignar a mano.
 *
 * Nada de esto envía mensajes: quien llama avisa con los viajes que devuelve.
 */

/** Más viejo que esto sin decidir, el modo sombra deja de evaluarlo. */
const MAX_AGE_MS = 3 * 60 * 60_000;
const ENGINE_TIMEOUT_MS = 3_000;

type EngineStop = { tipo: RouteStop["tipo"]; pedido: number | null };

type EngineResponse = {
  engine_version: string;
  despacho: { despachar_ts: number; faltan_min: number };
  ganador: string | null;
  plan: EngineStop[] | null;
  motos: { id: string; elegible: boolean; motivo: string | null }[];
};

async function callEngine(request: unknown): Promise<EngineResponse> {
  const response = await fetch(`${env.engineUrl}/evaluar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body?.error ?? ""}`);
  return body as EngineResponse;
}

const EXCLUSION: Record<string, string> = {
  sin_senal: "sin GPS",
  fuera_radio: "lejos",
  cliente_no_contesta: "esperando a un cliente",
  ocupada_sin_multipedido: "ocupadas",
  capacidad: "con el cupo lleno",
  retraso: "retrasarían otro pedido",
};

/** "sin GPS: 4, lejos: 1": por qué ninguna moto fue elegible. Lo lee la central. */
function exclusionSummary(motos: EngineResponse["motos"]) {
  const counts = new Map<string, number>();
  for (const m of motos) if (m.motivo) counts.set(m.motivo, (counts.get(m.motivo) ?? 0) + 1);
  return [...counts].map(([motivo, n]) => `${EXCLUSION[motivo] ?? motivo}: ${n}`).join(", ") || "no hay motos conectadas";
}

async function save(tripId: number, values: Partial<typeof schema.engineEvaluations.$inferInsert>) {
  const now = new Date();
  await db
    .insert(schema.engineEvaluations)
    .values({ tripId, ...values, updatedAt: now })
    .onConflictDoUpdate({ target: schema.engineEvaluations.tripId, set: { ...values, updatedAt: now } });
}

/** Las motos conectadas con lo que llevan encima. */
async function loadCouriers(): Promise<SnapshotCourier[]> {
  const couriers = await db
    .select()
    .from(schema.couriers)
    .where(and(eq(schema.couriers.active, true), dispatchableCourier(), inArray(schema.couriers.status, ["available", "busy"])));
  if (!couriers.length) return [];
  const ids = couriers.map((c) => c.id);

  const [active, delivered, routes, botConfig] = await Promise.all([
    db
      .select({ courierId: schema.assignments.courierId, trip: schema.trips, assignment: schema.assignments })
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(and(inArray(schema.assignments.courierId, ids), openTripCondition()))
      .orderBy(schema.assignments.assignedAt),
    db
      .select({ courierId: schema.assignments.courierId, last: max(schema.assignments.deliveredAt) })
      .from(schema.assignments)
      .where(inArray(schema.assignments.courierId, ids))
      .groupBy(schema.assignments.courierId),
    db.select().from(schema.courierRoutes).where(inArray(schema.courierRoutes.courierId, ids)),
    getBotConfig(),
  ]);
  const lastDelivered = new Map(delivered.map((d) => [d.courierId, d.last]));
  const route = new Map(routes.map((r) => [r.courierId, r.stops]));

  return couriers.map((c) => ({
    id: c.id,
    lat: c.lat,
    lng: c.lng,
    locationUpdatedAt: c.locationUpdatedAt,
    deliveriesThisShift: c.deliveriesThisShift,
    shiftStartedAt: c.shiftStartedAt,
    lastDeliveredAt: lastDelivered.get(c.id) ?? null,
    route: route.get(c.id) ?? null,
    activeTrips: active
      .filter((a) => a.courierId === c.id)
      .map((a) => ({
        ...a.trip,
        phase: tripPhase({ ...a.assignment, status: a.trip.status }),
        customerWaitEndsAt: a.assignment.customerWaitAt ? customerWaitEndsAt({ customerWaitAt: a.assignment.customerWaitAt }, botConfig) : null,
      })),
  }));
}

type Evaluated = { winner: number; faltan: number; plan: EngineStop[] | null } | null;

/** Evalúa un viaje y guarda por qué sigue esperando. `null` si no hay ganadora o
 *  no se pudo evaluar; ahí queda el motivo para quien lo mire. */
async function evaluate(
  trip: typeof schema.trips.$inferSelect,
  previous: number,
  couriers: SnapshotCourier[],
  now: Date,
  config: EngineConfig,
): Promise<{ result: Evaluated; common: Partial<typeof schema.engineEvaluations.$inferInsert> }> {
  const built = buildEvaluarRequest(trip, couriers, now, config);
  if (!built.ok) {
    await save(trip.id, { status: "waiting", reason: `Faltan datos: ${built.missing.join(", ")}` });
    return { result: null, common: {} };
  }

  const evaluations = previous + 1;
  let response: EngineResponse;
  try {
    response = await callEngine(built.request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[engine] falló con el viaje ${trip.id}:`, message);
    await save(trip.id, { status: "waiting", reason: `Engine: ${message}`, request: built.request, evaluations });
    return { result: null, common: {} };
  }

  const faltan = response.despacho.faltan_min;
  const winner = response.ganador === null ? null : Number(response.ganador);
  const common = {
    courierId: winner,
    faltanMin: faltan,
    dispatchAt: new Date(response.despacho.despachar_ts * 1000),
    engineVersion: response.engine_version,
    request: built.request,
    response,
    evaluations,
  };

  if (winner === null) {
    await save(trip.id, { ...common, status: "waiting", reason: `Sin motos elegibles (${exclusionSummary(response.motos)})` });
    return { result: null, common };
  }
  return { result: { winner, faltan, plan: response.plan }, common };
}

async function runShadow(config: EngineConfig) {
  const now = new Date();
  // Los que siguen esperando, y los abiertos recientes que aún no se
  // evaluaron. Los decididos o expirados ya no se tocan.
  const rows = await db
    .select({ trip: schema.trips, evaluation: schema.engineEvaluations })
    .from(schema.trips)
    .leftJoin(schema.engineEvaluations, eq(schema.engineEvaluations.tripId, schema.trips.id))
    .where(
      or(
        eq(schema.engineEvaluations.status, "waiting"),
        and(
          isNull(schema.engineEvaluations.id),
          inArray(schema.trips.status, ["pending", "assigned", "en_route"]),
          gt(schema.trips.createdAt, new Date(now.getTime() - MAX_AGE_MS)),
        ),
      ),
    )
    .orderBy(desc(schema.trips.createdAt));
  if (!rows.length) return;

  let couriers: SnapshotCourier[] | null = null;

  for (const { trip, evaluation } of rows) {
    if (trip.status === "cancelled" || trip.status === "delivered") {
      await save(trip.id, { status: "expired", reason: `El viaje quedó ${trip.status === "cancelled" ? "cancelado" : "entregado"} antes de que el engine decidiera` });
      continue;
    }
    if (now.getTime() - trip.createdAt.getTime() > MAX_AGE_MS) {
      await save(trip.id, { status: "expired", reason: "Más de 3 horas sin decidir" });
      continue;
    }

    couriers ??= await loadCouriers();
    const { result, common } = await evaluate(trip, evaluation?.evaluations ?? 0, couriers, now, config);
    if (!result) continue;
    if (result.faltan > 0) await save(trip.id, { ...common, status: "waiting", reason: `Se despacharía en ${result.faltan} min` });
    else await save(trip.id, { ...common, status: "decided", reason: null, decidedAt: now });
  }
}

/** Evalúa un pedido pendiente y, si ya es hora, se lo asigna a la ganadora y
 *  guarda su ruta. Devuelve si quedó asignado. */
async function assignIfDue(trip: typeof schema.trips.$inferSelect, previous: number, couriers: SnapshotCourier[], config: EngineConfig) {
  const now = new Date();
  const { result, common } = await evaluate(trip, previous, couriers, now, config);
  if (!result) return false;
  if (result.faltan > 0) {
    await save(trip.id, { ...common, status: "waiting", reason: `Se despacha en ${result.faltan} min` });
    return false;
  }

  const assigned = await assignTripTo(trip.id, result.winner);
  if (!assigned) {
    await save(trip.id, { ...common, status: "waiting", reason: "La moto elegida ya no está disponible" });
    return false;
  }
  if (result.plan) await saveCourierRoute(result.winner, result.plan.map((s) => ({ tipo: s.tipo, pedido: s.pedido ?? trip.id })));
  await save(trip.id, { ...common, status: "decided", reason: null, decidedAt: now });
  return true;
}

/** Modo `auto`: los pendientes, el más viejo primero. Tras cada asignación se
 *  vuelve a leer la flota: esa moto ya tiene otra ruta para el siguiente pedido. */
async function runAuto(config: EngineConfig): Promise<number[]> {
  const rows = await db
    .select({ trip: schema.trips, evaluation: schema.engineEvaluations })
    .from(schema.trips)
    .leftJoin(schema.engineEvaluations, eq(schema.engineEvaluations.tripId, schema.trips.id))
    .where(eq(schema.trips.status, "pending"))
    .orderBy(asc(schema.trips.createdAt));
  if (!rows.length) return [];

  const assigned: number[] = [];
  let couriers = await loadCouriers();
  for (const { trip, evaluation } of rows) {
    if (await assignIfDue(trip, evaluation?.evaluations ?? 0, couriers, config)) {
      assigned.push(trip.id);
      couriers = await loadCouriers();
    }
  }
  return assigned;
}

/** Lo corre el tick. Devuelve los viajes que acaban de recibir moto. */
export async function runEngine(): Promise<number[]> {
  if (!env.engineUrl) return [];
  const config = await getEngineConfig();
  if (config.mode === "auto") return runAuto(config);
  if (config.mode === "shadow") await runShadow(config);
  return [];
}

/** Modo `auto`, al confirmar un pedido: si ya es hora se asigna en el acto y el
 *  restaurante recibe un solo mensaje, con quién va. */
export async function dispatchTrip(tripId: number): Promise<boolean> {
  if (!env.engineUrl) return false;
  const [trip] = await db.select().from(schema.trips).where(and(eq(schema.trips.id, tripId), eq(schema.trips.status, "pending"))).limit(1);
  if (!trip) return false;
  try {
    return await assignIfDue(trip, 0, await loadCouriers(), await getEngineConfig());
  } catch (error) {
    console.error(`[engine] no se pudo despachar el viaje ${tripId}:`, error);
    return false;
  }
}

/** Un pedido recién confirmado: con el engine al frente, lo despacha él cuando
 *  sea la hora; si no, la cola le da la próxima moto libre. Devuelve si quedó
 *  asignado ya. */
export async function dispatchNewTrip(tripId: number): Promise<boolean> {
  if ((await getEngineConfig()).mode === "auto") return dispatchTrip(tripId);
  return Boolean(await assignNextCourier(tripId));
}
