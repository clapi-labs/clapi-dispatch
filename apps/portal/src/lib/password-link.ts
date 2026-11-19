import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Enlace temporal para crear o restablecer una contraseña (`/clave/<token>`).
 * Sin tablas nuevas: el token es `<payload>.<firma>`, firmado con HMAC-SHA256 y
 * SESSION_SECRET (como la cookie de sesión), y lleva el usuario, cuándo vence
 * y `f`, la huella de la contraseña que el usuario tiene HOY (los primeros 16
 * caracteres del SHA-256 de `users.password_hash`).
 *
 * Es de un solo uso sin guardar nada: al guardar la clave nueva cambia
 * `password_hash`, la huella deja de coincidir y el enlace (y cualquier otro
 * emitido antes) queda inservible. Vence a las 24 horas.
 */

export const PASSWORD_LINK_TTL_SECONDS = 24 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 8;

type Payload = { u: number; exp: number; f: string };
export type PasswordLinkToken = { userId: number; expiresAt: number; fingerprint: string };

function secret(): string | null {
  const value = process.env.SESSION_SECRET;
  return value && value.length >= 32 ? value : null;
}

// El prefijo separa esta firma de la de la cookie de sesión: un token no vale como el otro.
function sign(body: string, key: string): string {
  return createHmac("sha256", key).update(`clave:${body}`).digest("base64url");
}

/** La huella de una contraseña guardada: cambia en cuanto cambia la contraseña. */
export function passwordFingerprint(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

export function sameFingerprint(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `now` en milisegundos; el token vence a las 24 horas. */
export function createPasswordLinkToken(userId: number, passwordHash: string, now = Date.now()): string {
  const key = secret();
  if (!key) throw new Error("Falta SESSION_SECRET (mínimo 32 caracteres).");
  const payload: Payload = { u: userId, exp: Math.floor(now / 1000) + PASSWORD_LINK_TTL_SECONDS, f: passwordFingerprint(passwordHash) };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/** El contenido del token si la firma es válida y no venció; si no, null.
 *  No mira la base: que siga sin usarse lo dice la huella (`db/queries/password-link.ts`). */
export function verifyPasswordLinkToken(token: string | undefined, now = Date.now()): PasswordLinkToken | null {
  const key = secret();
  if (!key || !token) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(body, key));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload;
    if (typeof payload.u !== "number" || typeof payload.exp !== "number" || typeof payload.f !== "string") return null;
    if (payload.exp < now / 1000) return null;
    return { userId: payload.u, expiresAt: payload.exp, fingerprint: payload.f };
  } catch {
    return null;
  }
}
