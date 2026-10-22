/**
 * Límite de intentos de login, en memoria: 5 fallos por clave (correo + IP) y
 * se bloquea 15 minutos. Basta mientras haya un solo proceso del portal; con
 * varias réplicas habría que moverlo a la base de datos.
 */

const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;

const fails = new Map<string, { count: number; first: number }>();

export function isBlocked(key: string): boolean {
  const entry = fails.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    fails.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILS;
}

export function recordFailure(key: string) {
  const entry = fails.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    fails.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

export function clearFailures(key: string) {
  fails.delete(key);
}
