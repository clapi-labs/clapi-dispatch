import { randomBytes } from "node:crypto";

import { and, desc, eq, gte, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { db, listControls, openTripCondition, releaseControlOf, returnUnpickedTrips, schema, simulatorEnabled } from "@dispatch/shared/db";

/** "300 123 4567" → "573001234567": el formato en que WhatsApp identifica el
 *  número, para que el bot reconozca al motorizado cuando escriba. */
function toWaId(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `57${digits}` : digits;
}

export type CourierRow = typeof schema.couriers.$inferSelect;

/** Cómo responde al mensaje en los últimos 7 días: cuánto tarda en tocar «Voy
 *  en camino» y cuántas veces hubo que recordárselo. */
export type SeenStats = { confirmed: number; avgMinutes: number | null; reminders: number };

const STATS_DAYS = 7;

/** Con el simulador: si es una moto simulada, un número de prueba o una moto
 *  real con GPS, y con quién está emparejada ahora (el número que la controla, o
 *  la moto que controla). */
export type SimulatorRole = { role: "simulated" | "test" | "real"; partner: string | null };

export async function listCouriers(): Promise<
  (CourierRow & { seenStats: SeenStats | null; assignable: boolean; hasGps: boolean; simulator: SimulatorRole | null })[]
> {
  const a = schema.assignments;
  const simulator = simulatorEnabled();
  const [couriers, stats, controls, withGps] = await Promise.all([
    db.select().from(schema.couriers).where(eq(schema.couriers.active, true)).orderBy(desc(schema.couriers.createdAt)),
    db
      .select({
        courierId: a.courierId,
        confirmed: sql<number>`count(${a.seenAt})::int`,
        reminders: sql<number>`count(${a.seenReminderAt})::int`,
        avgSeconds: sql<number | null>`avg(extract(epoch from ${a.seenAt} - ${a.assignedAt}))::float`,
      })
      .from(a)
      .where(and(isNotNull(a.courierId), gte(a.assignedAt, new Date(Date.now() - STATS_DAYS * 24 * 60 * 60_000))))
      .groupBy(a.courierId),
    simulator ? listControls() : Promise.resolve([]),
    db.select({ id: schema.courierProfiles.courierId }).from(schema.courierProfiles).where(isNotNull(schema.courierProfiles.gpsDeviceId)),
  ]);
  const gps = new Set(withGps.map((r) => r.id));
  const byCourier = new Map(stats.map((r) => [r.courierId, r]));
  const names = new Map(couriers.map((c) => [c.id, c.name]));
  const partnerOf = (c: CourierRow) => {
    const control = controls.find((x) => (c.simulated ? x.simCourierId === c.id : x.phoneCourierId === c.id));
    const other = c.simulated ? control?.phoneCourierId : control?.simCourierId;
    return other ? (names.get(other) ?? null) : null;
  };
  const role = (c: CourierRow): SimulatorRole["role"] => (c.simulated ? "simulated" : gps.has(c.id) ? "real" : "test");
  return couriers.map((c) => {
    const r = byCourier.get(c.id);
    const seenStats =
      r && (r.confirmed || r.reminders)
        ? { confirmed: r.confirmed, reminders: r.reminders, avgMinutes: r.avgSeconds == null ? null : Math.round((r.avgSeconds / 60) * 10) / 10 }
        : null;
    return {
      ...c,
      seenStats,
      hasGps: gps.has(c.id),
      // A quién puede asignarle la central: con el simulador, a las simuladas y,
      // para un viaje de prueba, a las reales con GPS (simulator-flag.ts).
      assignable: c.simulated === simulator || (simulator && gps.has(c.id)),
      simulator: simulator ? { role: role(c), partner: partnerOf(c) } : null,
    };
  });
}

export async function createCourier(input: { name: string; phone: string; lat?: number; lng?: number }) {
  const [courier] = await db
    .insert(schema.couriers)
    .values({
      name: input.name,
      phone: toWaId(input.phone),
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      // Gris hasta que escriba por primera vez: escribirle al bot es conectarse.
      status: "offline",
      locationUpdatedAt: input.lat !== undefined ? new Date() : null,
      shiftStartedAt: new Date(),
    })
    .returning();
  return courier;
}

/** Encender o apagar desde Flota. Devuelve también los viajes que le quitó al
 *  desconectarse: lo que no ha recogido se asigna de nuevo y termina lo que ya
 *  lleva. Si se conecta llevando algo, queda ocupada. */
export async function updateCourierStatus(id: number, status: schema.CourierStatus) {
  const returned = status === "offline" ? await returnUnpickedTrips(id) : [];
  const [current] =
    status === "available"
      ? await db
          .select({ id: schema.trips.id })
          .from(schema.assignments)
          .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
          .where(and(eq(schema.assignments.courierId, id), openTripCondition()))
          .limit(1)
      : [];
  const [courier] = await db
    .update(schema.couriers)
    .set({ status: current ? "busy" : status })
    .where(eq(schema.couriers.id, id))
    .returning();
  return { courier, returned };
}

/** El identificador con que su celular reporta el GPS. Se genera una sola vez:
 *  cambiarlo obligaría a configurar la app otra vez. */
export async function ensureGpsDeviceId(courierId: number): Promise<string> {
  const generated = `moto-${randomBytes(9).toString("base64url")}`;
  await db.insert(schema.courierProfiles).values({ courierId, gpsDeviceId: generated }).onConflictDoNothing();
  await db
    .update(schema.courierProfiles)
    .set({ gpsDeviceId: generated })
    .where(and(eq(schema.courierProfiles.courierId, courierId), isNull(schema.courierProfiles.gpsDeviceId)));
  const [row] = await db.select({ id: schema.courierProfiles.gpsDeviceId }).from(schema.courierProfiles).where(eq(schema.courierProfiles.courierId, courierId)).limit(1);
  // En staging, con GPS deja de ser un número de prueba: suelta la moto simulada.
  if (simulatorEnabled()) await releaseControlOf(courierId);
  return row?.id ?? generated;
}

export async function setCourierPhoto(id: number, photo: string | null) {
  const [courier] = await db.update(schema.couriers).set({ photo }).where(eq(schema.couriers.id, id)).returning();
  return courier ?? null;
}

export type CourierProfile = Pick<
  typeof schema.courierProfiles.$inferSelect,
  "vehiclePlate" | "vehicleType" | "documentId" | "emergencyContactName" | "emergencyContactPhone"
>;

export type CourierProfileWithGps = CourierProfile & { gpsDeviceId: string | null };

/** La ficha de "Ver más": vehículo y datos personales. Un motorizado al que
 *  todavía no se le ha llenado no tiene fila, y sale con todo vacío. */
export async function getCourierProfile(courierId: number): Promise<CourierProfileWithGps> {
  const [row] = await db.select().from(schema.courierProfiles).where(eq(schema.courierProfiles.courierId, courierId)).limit(1);
  return {
    vehiclePlate: row?.vehiclePlate ?? null,
    vehicleType: row?.vehicleType ?? null,
    documentId: row?.documentId ?? null,
    emergencyContactName: row?.emergencyContactName ?? null,
    emergencyContactPhone: row?.emergencyContactPhone ?? null,
    gpsDeviceId: row?.gpsDeviceId ?? null,
  };
}

export async function saveCourierProfile(courierId: number, profile: CourierProfile): Promise<CourierProfile> {
  await db
    .insert(schema.courierProfiles)
    .values({ courierId, ...profile })
    .onConflictDoUpdate({ target: schema.courierProfiles.courierId, set: { ...profile, updatedAt: new Date() } });
  return profile;
}

/** Quitar de la flota sin borrar: su nombre sigue en el arqueo de los viajes
 *  que ya hizo. Un motorizado en un viaje no se puede quitar. */
export async function removeCourier(id: number) {
  await db
    .update(schema.couriers)
    .set({ active: false, status: "offline" })
    .where(and(eq(schema.couriers.id, id), ne(schema.couriers.status, "busy")));
}

export const EMERGENCY_REASON = "Emergencia marcada desde Flota.";

/**
 * Emergencia (rojo): un accidente, una moto varada. El despacho no le asigna
 * nada más (solo asigna a los libres) y lo que lleva sigue a su nombre para
 * que la central decida. Su chat queda en manos de la central, fijado arriba
 * en Conversaciones; si nunca había escrito, se le abre uno.
 *
 * Al quitarla vuelve el bot y queda en viaje si todavía lleva algo, o libre.
 */
export async function setCourierEmergency(id: number, on: boolean) {
  const [courier] = await db.select().from(schema.couriers).where(eq(schema.couriers.id, id)).limit(1);
  if (!courier) return null;

  let status: schema.CourierStatus = "paused";
  if (!on) {
    const [current] = await db
      .select({ id: schema.trips.id })
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(and(eq(schema.assignments.courierId, id), openTripCondition()))
      .limit(1);
    status = current ? "busy" : "available";
  }

  const [updated] = await db.update(schema.couriers).set({ status }).where(eq(schema.couriers.id, id)).returning();
  const chat = on
    ? { botPaused: true, escalationReason: `${EMERGENCY_REASON} ${courier.name}`, lastMessageAt: new Date() }
    : { botPaused: false, escalationReason: null };
  await db
    .insert(schema.conversations)
    .values({ phone: courier.phone, displayName: courier.name, ...chat })
    .onConflictDoUpdate({ target: schema.conversations.phone, set: { ...chat, draft: null, failedAttempts: 0 } });
  return updated;
}
