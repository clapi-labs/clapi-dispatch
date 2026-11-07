import { randomBytes } from "node:crypto";

import { and, asc, eq, inArray, isNotNull, isNull, max, notInArray, or, sql } from "drizzle-orm";

import { db } from "./client";
import { openTripCondition } from "./dispatch-queue";
import { getEngineConfig } from "./engine-config";
import { assignments, conversations, courierProfiles, couriers, restaurants, settings, simulatorControls, trips } from "./schema";
import { simulatorEnabled } from "./simulator-flag";

/**
 * El simulador de staging (docs/OPERACION.md, «Simulador»). Mueve motos y
 * muestra lo que pasa, pero no asigna ni envía: las motos simuladas son filas
 * de `couriers` y todo pedido sigue el camino de producción. Aquí solo vive lo
 * propio del simulador: sus motos, sus ajustes y qué número de prueba controla
 * cada una.
 */

export const SIMULATOR_KEY = "simulator";

type Point = { lat: number; lng: number };

export type SimulatorConfig = {
  /** Cuántas veces más rápido se mueven las motos. No acelera la cocina: el
   *  sistema usa la hora real. */
  speed: number;
  /** Cuántas motos simuladas se crean al reiniciar. */
  motos: number;
  /** De las motos que se manejan solas, qué parte deja en portería, vuelve a
   *  recogida o reporta un cliente que no contesta (0 a 100). */
  gatePercent: number;
  returnPercent: number;
  noAnswerPercent: number;
  /** Motos que se movieron a mano desde el mapa: se quedan ahí hasta soltarlas. */
  parked: Record<string, Point>;
  /** Los pedidos creados desde el mapa, para borrarlos al reiniciar. */
  trips: number[];
};

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  speed: 1,
  motos: 8,
  gatePercent: 20,
  returnPercent: 20,
  noAnswerPercent: 10,
  parked: {},
  trips: [],
};

const MAX_SAVED_TRIPS = 1000;

const percent = (value: unknown, fallback: number) => (typeof value === "number" && value >= 0 && value <= 100 ? value : fallback);

export async function getSimulatorConfig(): Promise<SimulatorConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SIMULATOR_KEY));
  const saved = (row?.value ?? {}) as Partial<SimulatorConfig>;
  const d = DEFAULT_SIMULATOR_CONFIG;
  return {
    speed: typeof saved.speed === "number" && saved.speed >= 1 && saved.speed <= 50 ? saved.speed : d.speed,
    motos: typeof saved.motos === "number" && saved.motos >= 1 && saved.motos <= 30 ? Math.round(saved.motos) : d.motos,
    gatePercent: percent(saved.gatePercent, d.gatePercent),
    returnPercent: percent(saved.returnPercent, d.returnPercent),
    noAnswerPercent: percent(saved.noAnswerPercent, d.noAnswerPercent),
    parked: saved.parked && typeof saved.parked === "object" ? saved.parked : {},
    trips: Array.isArray(saved.trips) ? saved.trips.filter((t): t is number => typeof t === "number") : [],
  };
}

export async function updateSimulatorConfig(change: (config: SimulatorConfig) => Partial<SimulatorConfig>): Promise<SimulatorConfig> {
  const current = await getSimulatorConfig();
  const next = { ...current, ...change(current) };
  next.trips = next.trips.slice(-MAX_SAVED_TRIPS);
  await db
    .insert(settings)
    .values({ key: SIMULATOR_KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next } });
  return next;
}

/** El radio del engine, que también es el del simulador. */
export async function setEngineRadius(radioKm: number) {
  const [row] = await db.select().from(settings).where(eq(settings.key, "engine_config"));
  const value = { ...((row?.value ?? {}) as Record<string, unknown>), radioKm };
  await db.insert(settings).values({ key: "engine_config", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

// ---------------------------------------------------------------------------
// Motos simuladas
// ---------------------------------------------------------------------------

const NAMES = ["Fabio", "Luis", "Carlos", "Andrés", "Jhon", "Diego", "Camilo", "Wilmer", "Óscar", "Mauricio", "Julián", "Sebastián"];
const CALI: Point = { lat: 3.4372, lng: -76.5225 };

/** Un número que no existe: solo letras y el id, así nunca coincide con un
 *  número real al comparar los últimos 10 dígitos. */
export const simulatedPhone = (courierId: number) => `SIM${courierId}`;

/** El centro del simulador: el promedio de los restaurantes ubicados. */
export async function simulatorHome(): Promise<Point> {
  const rows = await db
    .select({ location: restaurants.knownPickupLocation })
    .from(restaurants)
    .where(and(eq(restaurants.active, true), isNotNull(restaurants.knownPickupLocation)));
  const points = rows.map((r) => r.location).filter((p): p is Point => !!p);
  if (!points.length) return CALI;
  return { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length };
}

/** Un punto al azar a menos de `km` del centro. */
export function randomPointNear(center: Point, km: number): Point {
  const r = km * Math.sqrt(Math.random());
  const angle = Math.random() * 2 * Math.PI;
  return {
    lat: center.lat + (r / 111.32) * Math.cos(angle),
    lng: center.lng + (r / (111.32 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(angle),
  };
}

export async function createSimulatedCourier(at: Point) {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(couriers).where(eq(couriers.simulated, true));
  const base = NAMES[count % NAMES.length];
  const name = count < NAMES.length ? base : `${base} ${Math.floor(count / NAMES.length) + 1}`;
  const now = new Date();
  const [created] = await db
    .insert(couriers)
    .values({ name, phone: "SIM", status: "available", simulated: true, lat: at.lat, lng: at.lng, shiftStartedAt: now })
    .returning();
  const [courier] = await db.update(couriers).set({ phone: simulatedPhone(created.id) }).where(eq(couriers.id, created.id)).returning();
  // Aleatorio como el de un celular real: /api/gps es pública.
  await db.insert(courierProfiles).values({ courierId: courier.id, gpsDeviceId: `sim-${randomBytes(9).toString("base64url")}` });
  return courier;
}

/** Si no queda ninguna moto simulada, crea las del ajuste alrededor del centro. */
export async function ensureSimulatedCouriers() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(couriers)
    .where(and(eq(couriers.simulated, true), eq(couriers.active, true)));
  if (count > 0) return 0;
  const [config, engine, home] = await Promise.all([getSimulatorConfig(), getEngineConfig(), simulatorHome()]);
  for (let i = 0; i < config.motos; i++) await createSimulatedCourier(randomPointNear(home, engine.radioKm * 0.6));
  return config.motos;
}

/** Las motos simuladas con el identificador con que reportan el GPS. */
export async function listSimulatedCouriers() {
  return db
    .select({ courier: couriers, deviceId: courierProfiles.gpsDeviceId })
    .from(couriers)
    .leftJoin(courierProfiles, eq(courierProfiles.courierId, couriers.id))
    .where(and(eq(couriers.simulated, true), eq(couriers.active, true)))
    .orderBy(asc(couriers.id));
}

export async function isSimulatedCourier(courierId: number) {
  const [row] = await db.select({ id: couriers.id }).from(couriers).where(and(eq(couriers.id, courierId), eq(couriers.simulated, true))).limit(1);
  return Boolean(row);
}

/**
 * Borra solo lo simulado y vuelve a crear las motos: los pedidos de las motos
 * simuladas y los creados desde el mapa, sus chats y las motos. Restaurantes,
 * usuarios y motos reales quedan igual.
 */
export async function resetSimulation() {
  const sims = await db.select({ id: couriers.id, phone: couriers.phone }).from(couriers).where(eq(couriers.simulated, true));
  const config = await getSimulatorConfig();
  const simIds = sims.map((s) => s.id);
  const assigned = simIds.length
    ? await db.select({ tripId: assignments.tripId }).from(assignments).where(inArray(assignments.courierId, simIds))
    : [];
  const tripIds = [...new Set([...assigned.map((a) => a.tripId), ...config.trips])];
  if (tripIds.length) await db.delete(trips).where(inArray(trips.id, tripIds));
  if (sims.length) {
    await db.delete(conversations).where(inArray(conversations.phone, sims.map((s) => s.phone)));
    await db.delete(couriers).where(inArray(couriers.id, simIds));
  }
  await db.update(simulatorControls).set({ simCourierId: null, since: new Date() });
  await updateSimulatorConfig(() => ({ parked: {}, trips: [] }));
  return ensureSimulatedCouriers();
}

// ---------------------------------------------------------------------------
// Números de prueba: cada uno controla la próxima moto simulada que reciba un
// pedido, hasta que ya no le queden pedidos abiertos.
// ---------------------------------------------------------------------------

/** Tras cerrar su último pedido, la moto sigue con el número un momento: así le
 *  llega el «terminado» antes de soltarla. */
const RELEASE_GRACE_MS = 15_000;
const CONNECTED: ("available" | "busy")[] = ["available", "busy"];

type PhoneCourier = { id: number; name: string; phone: string };

/** El número que controla esa moto, si sigue conectado en Flota. */
export async function controllerOf(simCourierId: number): Promise<PhoneCourier | null> {
  const [row] = await db
    .select({ id: couriers.id, name: couriers.name, phone: couriers.phone })
    .from(simulatorControls)
    .innerJoin(couriers, eq(couriers.id, simulatorControls.phoneCourierId))
    .where(and(eq(simulatorControls.simCourierId, simCourierId), eq(couriers.active, true), inArray(couriers.status, CONNECTED)))
    .limit(1);
  return row ?? null;
}

/** La moto simulada que controla ese número. */
export async function controlledBy(phoneCourierId: number) {
  const [row] = await db
    .select({ courier: couriers })
    .from(simulatorControls)
    .innerJoin(couriers, eq(couriers.id, simulatorControls.simCourierId))
    .where(and(eq(simulatorControls.phoneCourierId, phoneCourierId), eq(couriers.active, true)))
    .limit(1);
  return row?.courier ?? null;
}

/** Todos los controles vigentes: número → moto. Lo lee el mapa. */
export async function listControls() {
  return db
    .select({ phoneCourierId: simulatorControls.phoneCourierId, simCourierId: simulatorControls.simCourierId, since: simulatorControls.since })
    .from(simulatorControls);
}

/**
 * Suelta las motos de los números que se quitaron o desconectaron en Flota, y las
 * que ya no tienen pedidos abiertos. La moto vuelve a manejarse sola sin perder
 * lo que lleva, y el número queda libre desde ahora.
 */
export async function releaseIdleControls() {
  const now = new Date();
  const connected = db.select({ id: couriers.id }).from(couriers).where(and(eq(couriers.active, true), inArray(couriers.status, CONNECTED)));
  await db
    .update(simulatorControls)
    .set({ simCourierId: null, since: now })
    .where(and(isNotNull(simulatorControls.simCourierId), notInArray(simulatorControls.phoneCourierId, connected)));

  const rows = await db
    .select({ phoneCourierId: simulatorControls.phoneCourierId, simCourierId: simulatorControls.simCourierId })
    .from(simulatorControls)
    .where(isNotNull(simulatorControls.simCourierId));
  for (const { phoneCourierId, simCourierId } of rows) {
    if (simCourierId === null) continue;
    const [open] = await db
      .select({ id: trips.id })
      .from(assignments)
      .innerJoin(trips, eq(trips.id, assignments.tripId))
      .where(and(eq(assignments.courierId, simCourierId), openTripCondition()))
      .limit(1);
    if (open) continue;
    const [last] = await db
      .select({ at: max(sql<Date>`greatest(${assignments.finishedAt}, ${assignments.deliveredAt}, ${assignments.assignedAt})`) })
      .from(assignments)
      .where(eq(assignments.courierId, simCourierId));
    const lastAt = last?.at ? new Date(last.at).getTime() : 0;
    if (now.getTime() - lastAt < RELEASE_GRACE_MS) continue;
    await db
      .update(simulatorControls)
      .set({ simCourierId: null, since: now })
      .where(and(eq(simulatorControls.phoneCourierId, phoneCourierId), eq(simulatorControls.simCourierId, simCourierId)));
  }
}

/**
 * La moto simulada acaba de recibir un pedido: si no tiene número, la toma el
 * número libre que lleva más tiempo libre. `taken` dice si la tomó ahora, para
 * mandarle también lo que la moto ya llevaba. `null` si nadie la controla y se
 * maneja sola.
 */
export async function claimControl(simCourierId: number): Promise<(PhoneCourier & { taken: boolean }) | null> {
  if (!simulatorEnabled() || !(await isSimulatedCourier(simCourierId))) return null;
  await releaseIdleControls();
  const current = await controllerOf(simCourierId);
  if (current) return { ...current, taken: false };
  // Un control de un número que ya no está conectado no cuenta.
  await db.update(simulatorControls).set({ simCourierId: null, since: new Date() }).where(eq(simulatorControls.simCourierId, simCourierId));

  const free = await db
    .select({ id: couriers.id, name: couriers.name, phone: couriers.phone, hasRow: simulatorControls.phoneCourierId })
    .from(couriers)
    .leftJoin(simulatorControls, eq(simulatorControls.phoneCourierId, couriers.id))
    .where(
      and(
        eq(couriers.simulated, false),
        eq(couriers.active, true),
        inArray(couriers.status, CONNECTED),
        or(isNull(simulatorControls.phoneCourierId), isNull(simulatorControls.simCourierId)),
      ),
    )
    // Libre desde que soltó su última moto o, si nunca tuvo una, desde que se agregó.
    .orderBy(sql`coalesce(${simulatorControls.since}, ${couriers.createdAt}) asc`, asc(couriers.id));

  for (const candidate of free) {
    try {
      const now = new Date();
      const [won] = candidate.hasRow
        ? await db
            .update(simulatorControls)
            .set({ simCourierId, since: now })
            .where(and(eq(simulatorControls.phoneCourierId, candidate.id), isNull(simulatorControls.simCourierId)))
            .returning({ id: simulatorControls.phoneCourierId })
        : await db
            .insert(simulatorControls)
            .values({ phoneCourierId: candidate.id, simCourierId, since: now })
            .onConflictDoNothing({ target: simulatorControls.phoneCourierId })
            .returning({ id: simulatorControls.phoneCourierId });
      if (won) return { id: candidate.id, name: candidate.name, phone: candidate.phone, taken: true };
    } catch {
      // Otro proceso le dio la moto a otro número en el mismo instante.
      const other = await controllerOf(simCourierId);
      return other ? { ...other, taken: false } : null;
    }
  }
  return null;
}
