import { db, schema } from "@dispatch/shared/db";
import { eq } from "drizzle-orm";

/**
 * ¿El usuario de la sesión sigue activo? La cookie solo dice quién es; si se
 * desactiva a alguien, su cookie sigue firmada hasta que vence (12 horas). Por
 * eso cada petición lo confirma en la base. La respuesta se recuerda unos
 * segundos para no consultar la base en cada recurso de la página: desactivar
 * a alguien lo saca del portal en, como mucho, ese tiempo.
 */

const CACHE_MS = 30_000;

const cache = new Map<number, { active: boolean; at: number }>();

export async function isActiveUser(userId: number): Promise<boolean> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.active;

  const [row] = await db.select({ active: schema.users.active }).from(schema.users).where(eq(schema.users.id, userId));
  const active = row?.active === true;
  cache.set(userId, { active, at: Date.now() });
  return active;
}
