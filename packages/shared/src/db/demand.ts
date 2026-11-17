import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";

import {
  DEFAULT_DEMAND_CONFIG,
  normalizeDemandConfig,
  pendingDemandChange,
  stepDemand,
  type DemandConfig,
  type DemandLevel,
  type DemandMetrics,
  type DemandSignal,
} from "../domain/demand";
import { hasSignal } from "../domain/gps";
import { db } from "./client";
import { openTripCondition } from "./trip-lifecycle";
import { assignments, couriers, demandChanges, demandState, settings, trips } from "./schema";
import { dispatchableCourier } from "./simulator-flag";

/**
 * La demanda en vivo (docs/ALGORITMO.md, «Demanda»). El tick la mide y la
 * guarda (`runDemand`); el engine, el bot y el portal la leen
 * (`getDemandLevel`, `getDemand`). El cálculo está en `domain/demand.ts`.
 */

export const DEMAND_CONFIG_KEY = "demand_config";

export async function getDemandConfig(): Promise<DemandConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, DEMAND_CONFIG_KEY));
  return row ? normalizeDemandConfig(row.value) : { ...DEFAULT_DEMAND_CONFIG };
}

export async function setDemandConfig(value: DemandConfig): Promise<DemandConfig> {
  await db.insert(settings).values({ key: DEMAND_CONFIG_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return value;
}

/** Los números de ahora, con la base. */
export async function measureDemand(config: DemandConfig, now = new Date()): Promise<DemandMetrics> {
  const since = new Date(now.getTime() - config.windowMin * 60_000);
  const horizon = now.getTime() + config.horizonMin * 60_000;

  const [connected, pending, [arrived]] = await Promise.all([
    db
      .select({
        id: couriers.id,
        lat: couriers.lat,
        lng: couriers.lng,
        locationUpdatedAt: couriers.locationUpdatedAt,
        locationMoving: couriers.locationMoving,
      })
      .from(couriers)
      .where(and(eq(couriers.active, true), dispatchableCourier(), inArray(couriers.status, ["available", "busy"]))),
    db.select({ readyAt: trips.readyAt }).from(trips).where(eq(trips.status, "pending")),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(trips)
      .where(and(gt(trips.createdAt, since), ne(trips.status, "cancelled"))),
  ]);

  // Con GPS cuentan las que lo tienen en vivo, como en el algoritmo. Si
  // ninguna lo tiene (operación sin GPS todavía), cuentan todas las conectadas.
  const live = connected.filter((c) => hasSignal(c, now));
  const counted = live.length ? live : connected;
  const ids = counted.map((c) => c.id);
  const loaded = ids.length
    ? await db
        .selectDistinct({ id: assignments.courierId })
        .from(assignments)
        .innerJoin(trips, eq(trips.id, assignments.tripId))
        .where(and(inArray(assignments.courierId, ids), openTripCondition()))
    : [];

  // Sin hora de listo cuenta como lista: no se sabe cuándo, y ya está esperando.
  const waiting = pending.filter((t) => !t.readyAt || t.readyAt.getTime() <= horizon).length;
  return {
    waiting,
    scheduled: pending.length - waiting,
    arrivals: arrived?.n ?? 0,
    windowMin: config.windowMin,
    connected: connected.length,
    live: live.length,
    counted: counted.length,
    free: counted.length - new Set(loaded.map((l) => l.id)).size,
  };
}

type StateRow = typeof demandState.$inferSelect;

async function readState(): Promise<StateRow | null> {
  const [row] = await db.select().from(demandState).where(eq(demandState.id, 1));
  return row ?? null;
}

/** El nivel de ahora. Antes de la primera medición, baja. */
export async function getDemandLevel(): Promise<DemandLevel> {
  return (await readState())?.level ?? "baja";
}

export type DemandSnapshot = {
  level: DemandLevel;
  since: Date | null;
  /** La medición del último tick. */
  measuredAt: Date | null;
  signal: DemandSignal | null;
  metrics: DemandMetrics | null;
  /** Si viene pidiendo el otro nivel: cuál y en cuántos minutos cambia si sigue así. */
  pending: { to: DemandLevel; minutesLeft: number } | null;
};

/** El nivel con su porqué, como lo dejó el último tick. */
export async function getDemand(now = new Date()): Promise<DemandSnapshot> {
  const [row, config] = await Promise.all([readState(), getDemandConfig()]);
  if (!row) return { level: "baja", since: null, measuredAt: null, signal: null, metrics: null, pending: null };
  return {
    level: row.level,
    since: row.since,
    measuredAt: row.measuredAt,
    signal: row.signal,
    metrics: row.metrics,
    pending: pendingDemandChange(row, config, now),
  };
}

/** Los últimos cambios, el más reciente primero. */
export async function listDemandChanges(limit = 50) {
  return db.select().from(demandChanges).orderBy(desc(demandChanges.at)).limit(limit);
}

/**
 * Lo corre el tick: mide, da un paso y lo guarda. Si el nivel cambia, queda en
 * `demand_changes`. Seguro en paralelo: todo se escribe con la condición de
 * que el nivel siga siendo el que se leyó, y el cambio lo registra solo el
 * tick que lo hizo.
 */
export async function runDemand(now = new Date()): Promise<{ level: DemandLevel; changed: boolean; metrics: DemandMetrics }> {
  const config = await getDemandConfig();
  const metrics = await measureDemand(config, now);

  await db.insert(demandState).values({ id: 1, level: "baja", since: now }).onConflictDoNothing();
  const row = await readState();
  if (!row) throw new Error("No se pudo leer demand_state");

  const step = stepDemand(row, metrics, config, now);
  const updated = await db
    .update(demandState)
    .set({
      level: step.state.level,
      since: step.state.since,
      candidateSince: step.state.candidateSince,
      measuredAt: now,
      signal: step.signal,
      metrics,
    })
    .where(and(eq(demandState.id, 1), eq(demandState.level, row.level)))
    .returning({ id: demandState.id });

  const changed = step.changed && updated.length > 0;
  if (changed) {
    await db.insert(demandChanges).values({ level: step.state.level, previous: row.level, at: now, metrics, config });
    console.log(`[demanda] ${row.level} → ${step.state.level}:`, JSON.stringify(metrics));
  }
  return { level: updated.length ? step.state.level : (await getDemandLevel()), changed, metrics };
}

