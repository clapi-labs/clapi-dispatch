import { NextResponse } from "next/server";

import { currentSession, promoteToInstalled, sessionCookie } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * El portal se abrió instalado en el celular (lo llama la página al cargar).
 * Si la sesión se abrió en el navegador antes de instalarlo, pasa a durar 30
 * días: así no hay que volver a escribir la contraseña a las 12 horas.
 */
export async function POST(request: Request) {
  const session = await currentSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (body.installed !== true) return Response.json({ ok: true, changed: false });

  const issued = await promoteToInstalled(session, request.headers.get("user-agent"));
  const response = NextResponse.json({ ok: true, changed: issued !== null });
  if (issued) response.cookies.set(SESSION_COOKIE, issued.token, sessionCookie(issued.maxAge));
  return response;
}
