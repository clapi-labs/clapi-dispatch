import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * La cookie `session`: `<payload>.<firma>`, firmada con HMAC-SHA256 y
 * SESSION_SECRET. El payload lleva el usuario, la sesión (`portal_sessions`)
 * y cuándo vence. La firma prueba que la cookie es nuestra; que la sesión
 * siga abierta lo dice la base (`lib/auth.ts`), y así se puede cerrar una
 * sola a distancia. Cambiar SESSION_SECRET cierra todas.
 *
 * En un computador vence a las 12 horas; en el portal instalado en el
 * celular, a los 30 días (`sessionMaxAge` en @dispatch/shared).
 */

export const SESSION_COOKIE = "session";

/** `AUTH_DISABLED=1` entra al portal sin login. Solo para desarrollo o una
 *  prueba corta: sin login, cualquiera con la dirección ve los chats y puede
 *  escribirles a los restaurantes y motorizados. */
export function authDisabled(): boolean {
  return process.env.AUTH_DISABLED === "1";
}
/** El simulador de staging y su API: siempre con sesión, aunque el login esté apagado. */
export function isSimulatorPath(pathname: string): boolean {
  return pathname === "/simulador" || pathname.startsWith("/simulador/") || pathname.startsWith("/api/simulador");
}

type Payload = { u: number; s: number; exp: number };

export type SessionToken = { userId: number; sessionId: number; expiresAt: number };

function secret(): string | null {
  const value = process.env.SESSION_SECRET;
  return value && value.length >= 32 ? value : null;
}

function sign(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

/** `expiresAt` en segundos desde 1970, el mismo que se guarda en la base. */
export function createSessionToken(userId: number, sessionId: number, expiresAt: number): string {
  const key = secret();
  if (!key) throw new Error("Falta SESSION_SECRET (mínimo 32 caracteres).");
  const payload: Payload = { u: userId, s: sessionId, exp: expiresAt };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/** El usuario y la sesión si la firma es válida y no venció; si no, null.
 *  No mira la base: para eso `getSession` (lib/auth.ts). Las cookies de
 *  antes de que hubiera sesiones en la base (sin `s`) ya no sirven. */
export function verifySessionToken(token: string | undefined): SessionToken | null {
  const key = secret();
  if (!key || !token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body, key));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload;
    if (typeof payload.u !== "number" || typeof payload.s !== "number" || typeof payload.exp !== "number") return null;
    if (payload.exp < Date.now() / 1000) return null;
    return { userId: payload.u, sessionId: payload.s, expiresAt: payload.exp };
  } catch {
    return null;
  }
}
