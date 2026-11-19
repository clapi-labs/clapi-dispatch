import { setPasswordWithLink } from "@/db/queries/password-link";
import { readJsonObject } from "@/lib/json";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-link";
import { clearFailures, isBlocked, recordFailure } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Guarda la contraseña que se escribió en `/clave/<token>`. Pública (la
 *  autoriza el token). Cierra las sesiones del usuario y quema el enlace. */
export async function POST(request: Request) {
  const body = (await readJsonObject(request)) ?? {};
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  if (!token) return Response.json({ error: "Falta el enlace" }, { status: 400 });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.` }, { status: 400 });
  }
  if (password !== confirm) return Response.json({ error: "Las contraseñas no coinciden." }, { status: 400 });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  const key = `clave|${ip}`;
  if (isBlocked(key)) return Response.json({ error: "Demasiados intentos. Prueba de nuevo en 15 minutos." }, { status: 429 });

  const user = await setPasswordWithLink(token, password);
  if (!user) {
    recordFailure(key);
    return Response.json({ error: "Este enlace ya fue utilizado o expiró. Pídele uno nuevo al administrador." }, { status: 410 });
  }
  clearFailures(key);
  return Response.json({ ok: true });
}
