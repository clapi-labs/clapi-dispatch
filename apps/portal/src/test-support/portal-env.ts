import { mock } from "node:test";

import { eq } from "drizzle-orm";

import { hashPassword } from "@dispatch/shared/auth/password";
import { assignTripTo, db, schema } from "@dispatch/shared/db";
import { createConversation, createCourier, createRestaurant, createTrip } from "@dispatch/shared/db/test-db";

import { SESSION_COOKIE } from "@/lib/session";

/**
 * Lo común de las pruebas del portal (`apps/portal/src/**\/*.test.ts`): las
 * rutas de la API y `proxy.ts` se llaman tal cual (con su `Request`), contra la
 * base de pruebas. Lo que solo existe dentro de una petición de Next o sale del
 * proceso se sustituye:
 *
 * - `cookies()` de `next/headers`: devuelve la cookie del «navegador» de la
 *   prueba (`browser`), que es lo que la ruta leería de la petición.
 * - El bot (`BOT_URL`): el `fetch` es de mentiras; cada llamada queda en
 *   `bot.calls` y se le dice qué contestar (`bot.reply`).
 *
 * `installMocks()` va en el `before` del archivo y las rutas se importan
 * después (`await import(...)`).
 */

export const SESSION_SECRET = "secreto-de-sesion-de-prueba-de-al-menos-32-caracteres";
export const PASSWORD = "clave-de-prueba-larga";

/** La cookie que el «navegador» manda con cada petición. */
export const browser: { cookie: string | undefined } = { cookie: undefined };

export type BotCall = { path: string; body: unknown; secret: string | null };
export const botCalls: BotCall[] = [];
export type BotReply = { status?: number; body?: unknown } | "network";
let botHandler: ((call: BotCall) => BotReply) | null = null;

/** Lo que contesta el bot (por defecto, `{ ok: true }` con 200); `null` lo devuelve a lo de siempre. */
export const bot = {
  get calls() {
    return botCalls;
  },
  reply(handler: ((call: BotCall) => BotReply) | BotReply | null) {
    botHandler = handler === null ? null : typeof handler === "function" ? handler : () => handler;
  },
};

export async function installMocks() {
  const headers = await import("next/headers");
  mock.module("next/headers", {
    namedExports: {
      ...headers,
      cookies: async () => ({
        get: (name: string) => (name === SESSION_COOKIE && browser.cookie ? { name, value: browser.cookie } : undefined),
        has: (name: string) => name === SESSION_COOKIE && !!browser.cookie,
        getAll: () => (browser.cookie ? [{ name: SESSION_COOKIE, value: browser.cookie }] : []),
      }),
    },
  });

  mock.method(globalThis, "fetch", async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const target = String(url instanceof Request ? url.url : url);
    const base = process.env.BOT_URL ?? "";
    if (!base || !target.startsWith(base.startsWith("http") ? base : `https://${base}`)) throw new Error(`fetch inesperado en la prueba: ${target}`);
    const call: BotCall = { path: new URL(target).pathname, body: JSON.parse(String(init?.body ?? "null")), secret: init?.headers?.["x-internal-secret"] ?? null };
    botCalls.push(call);
    const reply = botHandler ? botHandler(call) : { status: 200, body: { ok: true } };
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body ?? { ok: true }), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
}

export function resetMocks() {
  browser.cookie = undefined;
  botCalls.length = 0;
  botHandler = null;
  // Las sesiones que `lib/auth.ts` recuerda 15 s: cada prueba empieza sin memoria.
  (globalThis as { __portalSessions?: Map<number, unknown> }).__portalSessions?.clear();
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.BOT_URL = "http://bot.test";
  process.env.INTERNAL_SECRET = "secreto-interno-de-prueba";
  delete process.env.AUTH_DISABLED;
  delete process.env.BOT_HOST;
  delete process.env.SIMULATOR_ENABLED;
}

export function restoreMocks() {
  mock.restoreAll();
}

// ---------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------

export const ORIGIN = "http://portal.test";

export function request(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  const hasBody = opts.body !== undefined || opts.raw !== undefined;
  if (hasBody) headers["Content-Type"] ??= "application/json";
  return new Request(`${ORIGIN}${path}`, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
}

export const params = <T extends Record<string, string | number>>(values: T) => ({ params: Promise.resolve(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]))) as Promise<{ [K in keyof T]: string }> });

/** Lo que la respuesta le pide guardar al navegador: el valor de la cookie de sesión, y las opciones con que la puso. */
export function setCookieOf(response: Response) {
  const raw = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (raw === undefined) return null;
  const [pair, ...attributes] = raw.split(";").map((p) => p.trim());
  const value = pair.slice(SESSION_COOKIE.length + 1);
  const attr = (name: string) => attributes.find((a) => a.toLowerCase().startsWith(`${name.toLowerCase()}=`))?.split("=")[1];
  return {
    raw,
    value,
    maxAge: attr("Max-Age") === undefined ? null : Number(attr("Max-Age")),
    httpOnly: attributes.some((a) => a.toLowerCase() === "httponly"),
    secure: attributes.some((a) => a.toLowerCase() === "secure"),
    sameSite: attr("SameSite") ?? null,
    path: attr("Path") ?? null,
  };
}

/** El navegador hace caso a lo que la respuesta le pide guardar (o borrar). */
export function followCookies(response: Response) {
  const cookie = setCookieOf(response);
  if (cookie) browser.cookie = cookie.value || undefined;
  return cookie;
}

// ---------------------------------------------------------------------------
// Usuarios y sesiones
// ---------------------------------------------------------------------------

let seq = 0;

export async function createUser(over: Partial<typeof schema.users.$inferInsert> & { password?: string } = {}) {
  const n = ++seq;
  const { password = PASSWORD, ...rest } = over;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `central${n}@clapi.test`, name: `Central ${n}`, passwordHash: await hashPassword(password), ...rest })
    .returning();
  return user;
}

/** Abre una sesión como lo hace el login (`openSession`) y devuelve su cookie. */
export async function openSession(userId: number, installed = false, userAgent: string | null = null) {
  const { openSession: open } = await import("@/lib/auth");
  const issued = await open(userId, installed, userAgent);
  const { verifySessionToken } = await import("@/lib/session");
  return { ...issued, sessionId: verifySessionToken(issued.token)!.sessionId };
}

/** Un usuario con la sesión ya abierta en este «navegador». */
export async function signedIn(over: Parameters<typeof createUser>[0] = {}, installed = false) {
  const user = await createUser(over);
  const session = await openSession(user.id, installed);
  browser.cookie = session.token;
  return { user, session };
}

export const sessionRow = async (sessionId: number) => (await db.select().from(schema.portalSessions).where(eq(schema.portalSessions.id, sessionId)))[0];
export const sessionCount = async () => (await db.select().from(schema.portalSessions)).length;
/** Que `lib/auth.ts` olvide lo que recuerda: se mira la base de nuevo. */
export const forgetSessions = () => (globalThis as { __portalSessions?: Map<number, unknown> }).__portalSessions?.clear();

// ---------------------------------------------------------------------------
// Flota y viajes
// ---------------------------------------------------------------------------

export { createConversation, createCourier, createRestaurant, createTrip };

export const getTrip = async (id: number) => (await db.select().from(schema.trips).where(eq(schema.trips.id, id)))[0];
export const getCourier = async (id: number) => (await db.select().from(schema.couriers).where(eq(schema.couriers.id, id)))[0];
export const getAssignment = async (tripId: number) => (await db.select().from(schema.assignments).where(eq(schema.assignments.tripId, tripId)))[0];
export const getConversation = async (id: number) => (await db.select().from(schema.conversations).where(eq(schema.conversations.id, id)))[0];
export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** Un pedido ya asignado a esa moto, como lo deja el despacho. */
export async function assignedTrip(courierId: number, over: Parameters<typeof createTrip>[0] = {}) {
  const trip = await createTrip(over);
  const assigned = await assignTripTo(trip.id, courierId);
  if (!assigned) throw new Error("assignTripTo no asignó el viaje de prueba");
  return getTrip(trip.id);
}

export const setAssignment = (tripId: number, patch: Partial<typeof schema.assignments.$inferInsert>) =>
  db.update(schema.assignments).set(patch).where(eq(schema.assignments.tripId, tripId));
