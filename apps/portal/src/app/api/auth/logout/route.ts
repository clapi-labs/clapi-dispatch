import { NextResponse } from "next/server";

import { closeSession, currentSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/session";

/** Cierra la sesión de este equipo: se borra de la base, y con ella las alertas de este celular. */
export async function POST() {
  const session = await currentSession();
  if (session) await closeSession(session.sessionId);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
