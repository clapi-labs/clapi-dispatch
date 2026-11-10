import { and, desc, eq, gt, sql } from "drizzle-orm";
import { cookies } from "next/headers";

import { deviceLabel, sessionMaxAge } from "@dispatch/shared";
import { db, schema, subscriptionCounts } from "@dispatch/shared/db";

import { createSessionToken, SESSION_COOKIE, verifySessionToken, type SessionToken } from "@/lib/session";

/**
 * Las sesiones del portal en la base (`portal_sessions`). Lo usan proxy.ts en
 * cada pedido, las páginas y la API. Para no ir a la base en cada pedido, lo
 * que se revisó hace menos de `CHECK_MS` se da por bueno: una sesión cerrada
 * desde otro equipo deja de servir a más tardar en ese tiempo.
 */

const CHECK_MS = 15_000;
/** `last_seen_at` se actualiza a lo sumo cada tanto: no un UPDATE por pedido. */
const TOUCH_MS = 5 * 60_000;

type Entry = { alive: boolean; checkedAt: number };

// En globalThis: proxy.ts y las rutas pueden cargar este módulo por separado
// dentro del mismo proceso, y al cerrar una sesión deben enterarse ambos.
const g = globalThis as { __portalSessions?: Map<number, Entry> };
const cache: Map<number, Entry> = (g.__portalSessions ??= new Map());

/** La sesión de esta cookie si sigue abierta: firma válida, sin vencer, la
 *  fila existe y el usuario sigue activo. */
export async function getSession(token: string | undefined): Promise<SessionToken | null> {
  const parsed = verifySessionToken(token);
  if (!parsed) return null;

  const now = Date.now();
  const hit = cache.get(parsed.sessionId);
  if (hit && now - hit.checkedAt < CHECK_MS) return hit.alive ? parsed : null;

  const [row] = await db
    .select({
      userId: schema.portalSessions.userId,
      expiresAt: schema.portalSessions.expiresAt,
      lastSeenAt: schema.portalSessions.lastSeenAt,
      active: schema.users.active,
    })
    .from(schema.portalSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.portalSessions.userId))
    .where(eq(schema.portalSessions.id, parsed.sessionId));

  const alive = !!row && row.userId === parsed.userId && row.active && row.expiresAt.getTime() > now;
  cache.set(parsed.sessionId, { alive, checkedAt: now });

  if (alive && now - row.lastSeenAt.getTime() > TOUCH_MS) {
    await db
      .update(schema.portalSessions)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(schema.portalSessions.id, parsed.sessionId))
      .catch(() => {});
  }
  return alive ? parsed : null;
}

/** La sesión del pedido en curso (rutas de la API y páginas del servidor). */
export async function currentSession(): Promise<SessionToken | null> {
  return getSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export type IssuedSession = { token: string; maxAge: number };

/** Abre una sesión: 30 días si es el portal instalado en el celular, 12 horas si no. */
export async function openSession(userId: number, installed: boolean, userAgent: string | null): Promise<IssuedSession> {
  const maxAge = sessionMaxAge(installed);
  const expiresAt = Math.floor(Date.now() / 1000) + maxAge;
  const [row] = await db
    .insert(schema.portalSessions)
    .values({ userId, installed, device: deviceLabel(userAgent), expiresAt: new Date(expiresAt * 1000) })
    .returning({ id: schema.portalSessions.id });
  return { token: createSessionToken(userId, row.id, expiresAt), maxAge };
}

/**
 * El portal se abrió instalado en el celular con una sesión de navegador (se
 * entró desde Chrome y después se instaló): pasa a durar 30 días desde ahora.
 * Una vez, no en cada apertura: los 30 días se cuentan desde que se instaló.
 */
export async function promoteToInstalled(session: SessionToken, userAgent: string | null): Promise<IssuedSession | null> {
  const maxAge = sessionMaxAge(true);
  const expiresAt = Math.floor(Date.now() / 1000) + maxAge;
  const [row] = await db
    .update(schema.portalSessions)
    .set({ installed: true, device: deviceLabel(userAgent), expiresAt: new Date(expiresAt * 1000) })
    .where(and(eq(schema.portalSessions.id, session.sessionId), eq(schema.portalSessions.installed, false)))
    .returning({ id: schema.portalSessions.id });
  if (!row) return null;
  return { token: createSessionToken(session.userId, session.sessionId, expiresAt), maxAge };
}

/** Cierra una sesión (y con ella las alertas de ese celular). */
export async function closeSession(sessionId: number) {
  await db.delete(schema.portalSessions).where(eq(schema.portalSessions.id, sessionId));
  cache.set(sessionId, { alive: false, checkedAt: Date.now() });
}

/** Las sesiones abiertas de todos los usuarios, la más reciente primero. */
export async function listOpenSessions() {
  const rows = await db
    .select({
      id: schema.portalSessions.id,
      userName: schema.users.name,
      device: schema.portalSessions.device,
      installed: schema.portalSessions.installed,
      createdAt: schema.portalSessions.createdAt,
      lastSeenAt: schema.portalSessions.lastSeenAt,
      expiresAt: schema.portalSessions.expiresAt,
    })
    .from(schema.portalSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.portalSessions.userId))
    .where(and(gt(schema.portalSessions.expiresAt, sql`now()`), eq(schema.users.active, true)))
    .orderBy(desc(schema.portalSessions.lastSeenAt));
  const counts = await subscriptionCounts(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, alerts: (counts.get(r.id) ?? 0) > 0 }));
}

/** Opciones de la cookie de sesión. */
export function sessionCookie(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}
