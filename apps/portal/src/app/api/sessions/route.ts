import { currentSession, listOpenSessions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Las sesiones abiertas, para cerrar a distancia la de un celular perdido. */
export async function GET() {
  const session = await currentSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  return Response.json({ current: session.sessionId, sessions: await listOpenSessions() });
}
