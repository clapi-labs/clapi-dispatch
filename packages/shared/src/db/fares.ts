import { eq } from "drizzle-orm";

import { db } from "./client";
import { validateFareRanges, type FareRange } from "../domain/fare";
import { settings } from "./schema";

// ---------------------------------------------------------------------------
// Tarifa por distancia (rangos de kilómetros)
// ---------------------------------------------------------------------------

export const FARE_RANGES_KEY = "fare_ranges";

/**
 * La tabla por km vive en `settings` (clave/valor) y no en una tabla propia:
 * son pocas filas que se guardan siempre juntas, y así no hace falta migrar la
 * base. El tipo, la validación y el cálculo están en `domain/fare.ts`.
 */
export { priceForDistance, validateFareRanges, type FareRange } from "../domain/fare";

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
