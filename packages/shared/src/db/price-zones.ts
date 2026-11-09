import { asc, eq } from "drizzle-orm";

import { db } from "./client";
import { validateRing } from "./restricted-zones";
import { priceZones } from "./schema";

export type PriceZone = typeof priceZones.$inferSelect;
export type PriceZoneInput = {
  name: string;
  minPrice: number | null;
  ring: { lat: number; lng: number }[];
  barrioCode: string | null;
};

/** Hasta dónde se acepta un mínimo: un domicilio no vale más que esto. */
const MAX_MIN_PRICE = 1_000_000;

/** Lo que manda el mapa, validado. `minPrice` vacío o null: sin mínimo. */
export function validatePriceZone(input: unknown): { zone: PriceZoneInput } | { error: string } {
  const raw = (input ?? {}) as { name?: unknown; minPrice?: unknown; ring?: unknown; barrioCode?: unknown };
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
  if (!name) return { error: "Falta el nombre" };

  let minPrice: number | null = null;
  if (raw.minPrice !== null && raw.minPrice !== undefined && raw.minPrice !== "") {
    const value = Number(raw.minPrice);
    if (!Number.isInteger(value) || value < 0 || value > MAX_MIN_PRICE) return { error: "El mínimo debe ser un valor en pesos, sin decimales" };
    minPrice = value;
  }

  const ring = validateRing(raw.ring);
  if (!ring) return { error: "El contorno debe tener de 3 a 500 esquinas" };

  const barrioCode = typeof raw.barrioCode === "string" && /^[\w-]{1,20}$/.test(raw.barrioCode) ? raw.barrioCode : null;
  return { zone: { name, minPrice, ring, barrioCode } };
}

export function listPriceZones(): Promise<PriceZone[]> {
  return db.select().from(priceZones).orderBy(asc(priceZones.name), asc(priceZones.id));
}

export async function createPriceZone(zone: PriceZoneInput) {
  const [row] = await db.insert(priceZones).values(zone).returning();
  return row;
}

export async function updatePriceZone(id: number, zone: PriceZoneInput) {
  const [row] = await db
    .update(priceZones)
    .set({ ...zone, updatedAt: new Date() })
    .where(eq(priceZones.id, id))
    .returning();
  return row ?? null;
}

export async function deletePriceZone(id: number) {
  const rows = await db.delete(priceZones).where(eq(priceZones.id, id)).returning({ id: priceZones.id });
  return rows.length > 0;
}
