import { asc, eq } from "drizzle-orm";

import { db } from "./client";
import { restrictedZones } from "./schema";

export type RestrictedZone = typeof restrictedZones.$inferSelect;
export type ZoneInput = { name: string; note: string | null; ring: { lat: number; lng: number }[] };

/** Un contorno que llega del mapa: 3 a 500 puntos dentro de Colombia,
 *  redondeados a 6 decimales. `null` si no sirve. */
export function validateRing(input: unknown): ZoneInput["ring"] | null {
  if (!Array.isArray(input) || input.length < 3 || input.length > 500) return null;
  const ring: ZoneInput["ring"] = [];
  for (const p of input as { lat?: unknown; lng?: unknown }[]) {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -5 || lat > 13 || lng < -80 || lng > -66) return null;
    ring.push({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 });
  }
  return ring;
}

/** Lo que llega del mapa, validado: nombre, 3 a 500 puntos dentro de Colombia. */
export function validateZone(input: unknown): ZoneInput | null {
  const raw = input as { name?: unknown; note?: unknown; ring?: unknown } | null;
  const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 120) : "";
  const ring = validateRing(raw?.ring);
  if (!name || !ring) return null;
  const note = typeof raw?.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 500) : null;
  return { name, note, ring };
}

export function listRestrictedZones(): Promise<RestrictedZone[]> {
  return db.select().from(restrictedZones).orderBy(asc(restrictedZones.name));
}

export async function createRestrictedZone(zone: ZoneInput) {
  const [row] = await db.insert(restrictedZones).values(zone).returning();
  return row;
}

export async function updateRestrictedZone(id: number, zone: ZoneInput) {
  const [row] = await db
    .update(restrictedZones)
    .set({ ...zone, updatedAt: new Date() })
    .where(eq(restrictedZones.id, id))
    .returning();
  return row ?? null;
}

export async function deleteRestrictedZone(id: number) {
  const rows = await db.delete(restrictedZones).where(eq(restrictedZones.id, id)).returning({ id: restrictedZones.id });
  return rows.length > 0;
}
