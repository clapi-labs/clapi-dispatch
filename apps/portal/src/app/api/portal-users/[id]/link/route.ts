import { findPortalUserById } from "@/db/queries/portal-users";
import { isUserAdmin } from "@/lib/admin";
import { createPasswordLinkToken, PASSWORD_LINK_TTL_SECONDS } from "@/lib/password-link";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** La dirección pública del portal: detrás de Caddy, la del encabezado reenviado. */
function origin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

/** Genera el enlace de contraseña (24 h, un solo uso) de un usuario. Los
 *  enlaces anteriores siguen valiendo hasta que alguien guarda una clave. */
export async function POST(request: Request, { params }: Params) {
  if (!(await isUserAdmin())) return Response.json({ error: "Solo administradores" }, { status: 403 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Usuario inválido" }, { status: 400 });
  const user = await findPortalUserById(id);
  if (!user || !user.active) return Response.json({ error: "Usuario no encontrado" }, { status: 404 });
  const token = createPasswordLinkToken(user.id, user.passwordHash);
  return Response.json({ url: `${origin(request)}/clave/${token}`, expiresInSeconds: PASSWORD_LINK_TTL_SECONDS });
}
