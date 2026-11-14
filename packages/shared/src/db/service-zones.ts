import { asc, eq } from "drizzle-orm";

import { validateFareAdjustment } from "../domain/fare";
import { db } from "./client";
import { serviceZones, serviceZoneVersions } from "./schema";

/**
 * Las zonas de servicio que marca la central (docs/DIRECCIONES-Y-ZONAS.md,
 * «Zonas de servicio»). Cada cambio guarda la versión en
 * `service_zone_versions`, en la misma transacción.
 */

export type ServiceZone = typeof serviceZones.$inferSelect;
export type ServiceZoneInput = {
  name: string;
  ring: { lat: number; lng: number }[];
  barrioCode: string | null;
  /** Pesos que se suman al precio de la tabla por km (negativo: se restan). */
  fareAdjustment: number;
};

export const MAX_ZONE_VERTICES = 500;

/** Un contorno que llega del mapa: 3 a 500 puntos dentro de Colombia,
 *  redondeados a 6 decimales. `null` si no sirve. */
export function validateRing(input: unknown): ServiceZoneInput["ring"] | null {
  if (!Array.isArray(input) || input.length < 3 || input.length > MAX_ZONE_VERTICES) return null;
  const ring: ServiceZoneInput["ring"] = [];
  for (const p of input as { lat?: unknown; lng?: unknown }[]) {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -5 || lat > 13 || lng < -80 || lng > -66) return null;
    ring.push({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 });
  }
  return ring;
}

/** Lo que manda el mapa, validado: un nombre, el contorno y el ajuste de precio. */
export function validateServiceZone(input: unknown): { zone: ServiceZoneInput } | { error: string } {
  const raw = (input ?? {}) as { name?: unknown; ring?: unknown; barrioCode?: unknown; fareAdjustment?: unknown };
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
  if (!name) return { error: "Falta el nombre" };
  const ring = validateRing(raw.ring);
  if (!ring) return { error: `El borde debe tener de 3 a ${MAX_ZONE_VERTICES} esquinas` };
  const barrioCode = typeof raw.barrioCode === "string" && /^[\w-]{1,20}$/.test(raw.barrioCode) ? raw.barrioCode : null;
  const fareAdjustment = validateFareAdjustment(raw.fareAdjustment);
  if (fareAdjustment === null) return { error: "El ajuste debe ser un número entero de pesos, de −200.000 a 200.000" };
  return { zone: { name, ring, barrioCode, fareAdjustment } };
}

export function listServiceZones(): Promise<ServiceZone[]> {
  return db.select().from(serviceZones).orderBy(asc(serviceZones.name), asc(serviceZones.id));
}

type Action = "creada" | "editada" | "borrada";

/** Sin transacción: el driver HTTP de Neon no las tiene. El historial se
 *  escribe de modo que nunca se pierda una zona sin su última versión. */
async function saveVersion(zone: ServiceZone, action: Action, userId: number | null) {
  await db.insert(serviceZoneVersions).values({
    zoneId: zone.id,
    action,
    name: zone.name,
    ring: zone.ring,
    barrioCode: zone.barrioCode,
    fareAdjustment: zone.fareAdjustment,
    userId,
  });
}

export async function createServiceZone(zone: ServiceZoneInput, userId: number | null = null): Promise<ServiceZone> {
  const [row] = await db.insert(serviceZones).values(zone).returning();
  await saveVersion(row, "creada", userId);
  return row;
}

/** Cambia el nombre, el borde o el ajuste. `null` si la zona ya no existe. */
export async function updateServiceZone(id: number, zone: ServiceZoneInput, userId: number | null = null): Promise<ServiceZone | null> {
  const [row] = await db
    .update(serviceZones)
    .set({ ...zone, updatedAt: new Date() })
    .where(eq(serviceZones.id, id))
    .returning();
  if (row) await saveVersion(row, "editada", userId);
  return row ?? null;
}

/**
 * Cambia solo el ajuste de precio de varias zonas (lo guarda Tarifas). Cada
 * zona que cambia deja su versión. Devuelve las que ya no existen.
 */
export async function setZoneAdjustments(changes: { id: number; fareAdjustment: number }[], userId: number | null = null): Promise<number[]> {
  const missing: number[] = [];
  for (const change of changes) {
    const [row] = await db
      .update(serviceZones)
      .set({ fareAdjustment: change.fareAdjustment, updatedAt: new Date() })
      .where(eq(serviceZones.id, change.id))
      .returning();
    if (row) await saveVersion(row, "editada", userId);
    else missing.push(change.id);
  }
  return missing;
}

/** Borra la zona. Primero guarda su última versión en el historial. */
export async function deleteServiceZone(id: number, userId: number | null = null): Promise<boolean> {
  const [row] = await db.select().from(serviceZones).where(eq(serviceZones.id, id));
  if (!row) return false;
  await saveVersion(row, "borrada", userId);
  const deleted = await db.delete(serviceZones).where(eq(serviceZones.id, id)).returning({ id: serviceZones.id });
  return deleted.length > 0;
}
