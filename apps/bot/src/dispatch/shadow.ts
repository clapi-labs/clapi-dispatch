import { and, desc, eq, gt, inArray, isNull, max, or } from "drizzle-orm";

import { db, getEngineConfig, schema } from "@dispatch/shared/db";

import { buildEvaluarRequest, type SnapshotCourier } from "@/dispatch/engine-request";
import { env } from "@/env";

/**
 * Modo sombra (docs/ALGORITMO.md): la cola sigue asignando y aquí el engine
 * calcula al lado, en cada tick, a quién y cuándo habría asignado cada viaje.
 * Nada de esto toca la asignación real ni envía mensajes; si algo falla, se
 * registra y el tick sigue.
 */

/** Más viejo que esto sin decidir, se deja de evaluar. */
const MAX_AGE_MS = 3 * 60 * 60_000;
const ENGINE_TIMEOUT_MS = 3_000;

type EngineResponse = {
  engine_version: string;
  despacho: { despachar_ts: number; faltan_min: number };
  ganador: string | null;
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

/** "sin_senal: 4, fuera_radio: 1": por qué ninguna moto fue elegible. */
function exclusionSummary(motos: EngineResponse["motos"]) {
  const counts = new Map<string, number>();
  for (const m of motos) if (m.motivo) counts.set(m.motivo, (counts.get(m.motivo) ?? 0) + 1);
  return [...counts].map(([motivo, n]) => `${motivo}: ${n}`).join(", ") || "no hay motos conectadas";
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
    .where(and(eq(schema.couriers.active, true), inArray(schema.couriers.status, ["available", "busy"])));
  if (!couriers.length) return [];
  const ids = couriers.map((c) => c.id);

  const active = await db
    .select({ courierId: schema.assignments.courierId, trip: schema.trips })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(inArray(schema.assignments.courierId, ids), inArray(schema.trips.status, ["assigned", "en_route"])))
    .orderBy(schema.assignments.assignedAt);

  const delivered = await db
    .select({ courierId: schema.assignments.courierId, last: max(schema.assignments.deliveredAt) })
    .from(schema.assignments)
    .where(inArray(schema.assignments.courierId, ids))
    .groupBy(schema.assignments.courierId);
  const lastDelivered = new Map(delivered.map((d) => [d.courierId, d.last]));

  return couriers.map((c) => ({
    id: c.id,
    lat: c.lat,
    lng: c.lng,
    locationUpdatedAt: c.locationUpdatedAt,
    deliveriesThisShift: c.deliveriesThisShift,
    shiftStartedAt: c.shiftStartedAt,
    lastDeliveredAt: lastDelivered.get(c.id) ?? null,
    activeTrips: active.filter((a) => a.courierId === c.id).map((a) => a.trip),
  }));
}

export async function runShadow(): Promise<void> {
  if (!env.engineUrl) return;
  const config = await getEngineConfig();
  if (config.mode !== "shadow") return;

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
    const built = buildEvaluarRequest(trip, couriers, now, config);
    if (!built.ok) {
      await save(trip.id, { status: "waiting", reason: `Faltan datos: ${built.missing.join(", ")}` });
      continue;
    }

    const evaluations = (evaluation?.evaluations ?? 0) + 1;
    let result: EngineResponse;
    try {
      result = await callEngine(built.request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[sombra] el engine falló con el viaje ${trip.id}:`, message);
      await save(trip.id, { status: "waiting", reason: `Engine: ${message}`, request: built.request, evaluations });
      continue;
    }

    const faltan = result.despacho.faltan_min;
    const winner = result.ganador === null ? null : Number(result.ganador);
    const common = {
      courierId: winner,
      faltanMin: faltan,
      dispatchAt: new Date(result.despacho.despachar_ts * 1000),
      engineVersion: result.engine_version,
      request: built.request,
      response: result,
      evaluations,
    };

    if (winner === null) {
      await save(trip.id, { ...common, status: "waiting", reason: `Sin motos elegibles (${exclusionSummary(result.motos)})` });
    } else if (faltan > 0) {
      await save(trip.id, { ...common, status: "waiting", reason: `Se despacharía en ${faltan} min` });
    } else {
      await save(trip.id, { ...common, status: "decided", reason: null, decidedAt: now });
    }
  }
}
