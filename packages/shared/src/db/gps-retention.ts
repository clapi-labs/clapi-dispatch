import { and, isNotNull, lt, sql } from "drizzle-orm";

import { POSITION_RETENTION_MS } from "../domain/gps";
import { db } from "./client";
import { couriers, engineEvaluations } from "./schema";

/**
 * No se guarda el recorrido de los domiciliarios (issue #42): cada posición se
 * borra a las 24 horas. Hay dos lugares donde queda una:
 *
 * - `couriers`: solo la última de cada moto. Una moto que reporta sigue
 *   teniendo la suya; la de una que lleva más de 24 horas sin reportar se borra.
 * - `engine_evaluations.request`: la foto que se le mandó al algoritmo, con
 *   dónde estaba cada moto. Pasadas 24 horas se le quitan las posiciones de las
 *   motos y se conserva el resto (pedido, decisión y motivo).
 *
 * Las horas de cada servicio (llegó, recogió, entregó) están en `assignments` y
 * no se tocan. Lo corre el tick (`/api/internal/tick`); se puede llamar seguido.
 */
export async function purgeOldPositions(now = new Date()): Promise<{ couriers: number; evaluations: number }> {
  const cutoff = new Date(now.getTime() - POSITION_RETENTION_MS);

  // Primero se pregunta: un UPDATE sobre `couriers` avisa al portal aunque no
  // cambie ninguna fila, y el tick corre cada pocos segundos.
  const old = and(isNotNull(couriers.locationUpdatedAt), lt(couriers.locationUpdatedAt, cutoff));
  const [stale] = await db.select({ id: couriers.id }).from(couriers).where(old).limit(1);
  const cleared = stale
    ? await db.update(couriers).set({ lat: null, lng: null, locationUpdatedAt: null }).where(old).returning({ id: couriers.id })
    : [];

  const stripped = await db
    .update(engineEvaluations)
    .set({
      request: sql`jsonb_set(${engineEvaluations.request}, '{motos}', (
        select coalesce(jsonb_agg(m - 'lat' - 'lon'), '[]'::jsonb)
        from jsonb_array_elements(${engineEvaluations.request} -> 'motos') m
      ))`,
    })
    .where(
      and(
        lt(engineEvaluations.updatedAt, cutoff),
        sql`jsonb_typeof(${engineEvaluations.request} -> 'motos') = 'array'`,
        sql`exists (select 1 from jsonb_array_elements(${engineEvaluations.request} -> 'motos') m where m ? 'lat' or m ? 'lon')`,
      ),
    )
    .returning({ id: engineEvaluations.id });

  return { couriers: cleared.length, evaluations: stripped.length };
}
