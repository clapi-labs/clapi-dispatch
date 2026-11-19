import { createPortalUser, listPortalUsers } from "@/db/queries/portal-users";
import { isUserAdmin } from "@/lib/admin";
import { readJsonObject } from "@/lib/json";

export const dynamic = "force-dynamic";

/** Usuario corto o correo: sin espacios, minúsculas. No se exige «@». */
const LOGIN = /^[a-z0-9][a-z0-9._@+-]{1,63}$/;

/** Los usuarios del portal (tarjeta de /salud). Solo `PORTAL_ADMIN_EMAILS`. */
export async function GET() {
  if (!(await isUserAdmin())) return Response.json({ error: "Solo administradores" }, { status: 403 });
  return Response.json({ users: await listPortalUsers() });
}

/** Crea un usuario con una clave aleatoria; su clave real la pone él con el enlace. */
export async function POST(request: Request) {
  if (!(await isUserAdmin())) return Response.json({ error: "Solo administradores" }, { status: 403 });
  const body = (await readJsonObject(request)) ?? {};
  const login = typeof body.usuario === "string" ? body.usuario.trim().toLowerCase() : "";
  const name = typeof body.nombre === "string" ? body.nombre.trim() : "";
  if (!LOGIN.test(login)) return Response.json({ error: "Usuario inválido (2 a 64 letras, números, . _ - @ +, sin espacios)." }, { status: 400 });
  if (!name) return Response.json({ error: "Falta el nombre." }, { status: 400 });
  const user = await createPortalUser(login, name);
  if (!user) return Response.json({ error: "Ese usuario ya existe." }, { status: 409 });
  return Response.json({ user }, { status: 201 });
}
