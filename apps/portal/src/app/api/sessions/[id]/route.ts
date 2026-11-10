import { NextResponse } from "next/server";

import { closeSession, currentSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Cierra una sesión: ese equipo vuelve a pedir la contraseña y deja de recibir alertas. */
export async function DELETE(_request: Request, { params }: Params) {
  const session = await currentSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Sesión inválida" }, { status: 400 });

  await closeSession(id);
  const response = NextResponse.json({ ok: true, own: id === session.sessionId });
  if (id === session.sessionId) response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
