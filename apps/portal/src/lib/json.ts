/**
 * El cuerpo JSON de una petición como objeto, o `null` si no lo es: JSON
 * inválido, vacío, `null`, un número, un texto o una lista. Quien lo lee
 * decide qué hacer con `null`: lo más seguro es pedir el cuerpo (400); solo
 * donde «sin nada» es inofensivo se sigue con `?? {}`. Así un cuerpo raro
 * nunca llega a `body.algo` sobre `null` (un 500).
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}
