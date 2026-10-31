import { eq } from "drizzle-orm";

import { db } from "./client";
import { settings } from "./schema";

// ---------------------------------------------------------------------------
// Tarifa por distancia (rangos de kilómetros)
// ---------------------------------------------------------------------------

export const FARE_RANGES_KEY = "fare_ranges";

/**
 * Un tramo de la tabla por distancia: "hasta `upToKm` km cuesta `price`". Los
 * tramos van de menor a mayor y cada uno empieza donde termina el anterior. El
 * último no tiene tope (`upToKm: null`): "más de X km".
 *
 * Vive en `settings` (clave/valor) y no en una tabla propia: son pocas filas
 * que se guardan siempre juntas, y así no hace falta migrar la base.
 *
 * Es la única forma de cobrar: el bot ubica la recogida y la entrega en el
 * mapa y busca la distancia en esta tabla (`quoteByDistance`).
 */
export type FareRange = { upToKm: number | null; price: number };

/** La tabla de rangos válida, o `null` si no lo es: topes positivos y
 *  crecientes, precios enteros no negativos, y el último tramo sin tope. */
export function validateFareRanges(input: unknown): FareRange[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const ranges: FareRange[] = [];
  let previous = 0;
  for (let i = 0; i < input.length; i++) {
    const row = input[i] as { upToKm?: unknown; price?: unknown };
    const last = i === input.length - 1;
    if (!Number.isInteger(row?.price) || (row.price as number) < 0) return null;
    if (last) {
      if (row.upToKm !== null) return null;
      ranges.push({ upToKm: null, price: row.price as number });
    } else {
      if (typeof row.upToKm !== "number" || !Number.isFinite(row.upToKm)) return null;
      const km = Math.round(row.upToKm * 10) / 10; // una décima de km basta
      if (km <= previous) return null;
      previous = km;
      ranges.push({ upToKm: km, price: row.price as number });
    }
  }
  return ranges;
}

export async function getFareRanges(): Promise<FareRange[]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, FARE_RANGES_KEY));
  return validateFareRanges(row?.value) ?? [];
}

export async function saveFareRanges(ranges: FareRange[]) {
  await db
    .insert(settings)
    .values({ key: FARE_RANGES_KEY, value: ranges })
    .onConflictDoUpdate({ target: settings.key, set: { value: ranges } });
}

/** El precio para una distancia: el primer tramo que la cubre ("hasta 2 km"
 *  incluye los 2 km). `null` si la tabla está vacía. */
export function priceForDistance(km: number, ranges: FareRange[]): number | null {
  const range = ranges.find((r) => r.upToKm === null || km <= r.upToKm);
  return range?.price ?? null;
}
