import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sesión sin estado: una cookie `session` con `<payload>.<firma>`, firmada con
 * HMAC-SHA256 y SESSION_SECRET. No hay tabla de sesiones; para cerrar todas
 * las sesiones se cambia SESSION_SECRET. Vence a las 12 horas.
 */

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE = 12 * 60 * 60; // segundos

type Payload = { u: number; exp: number };

function secret(): string | null {
  const value = process.env.SESSION_SECRET;
  return value && value.length >= 32 ? value : null;
}

function sign(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

export function createSessionToken(userId: number): string {
  const key = secret();
  if (!key) throw new Error("Falta SESSION_SECRET (mínimo 32 caracteres).");
  const payload: Payload = { u: userId, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/** El id del usuario si la cookie es válida y no venció; si no, null. */
export function verifySessionToken(token: string | undefined): number | null {
  const key = secret();
  if (!key || !token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body, key));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload;
    if (typeof payload.u !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload.u;
  } catch {
    return null;
  }
}
