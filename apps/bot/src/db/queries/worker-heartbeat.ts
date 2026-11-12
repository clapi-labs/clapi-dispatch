import { db, schema } from "@dispatch/shared/db";
import { eq } from "drizzle-orm";

/**
 * La última vuelta completa del worker (`/api/internal/tick`), en `settings`.
 * Con ella `/api/health` sabe si la asignación se detuvo. Se guarda en la base,
 * no en memoria: así sobrevive a un reinicio del bot y un despliegue no cuenta
 * como worker detenido.
 */
const KEY = "worker_tick";

export async function recordWorkerTick(at = new Date()) {
  await db
    .insert(schema.settings)
    .values({ key: KEY, value: { at: at.toISOString() } })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: { at: at.toISOString() } } });
}

export async function lastWorkerTick(): Promise<Date | null> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, KEY));
  const at = (row?.value as { at?: unknown } | undefined)?.at;
  const date = typeof at === "string" ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}
