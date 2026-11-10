import { testMessage } from "@dispatch/shared";
import { sendPushToSession } from "@dispatch/shared/db";

import { currentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Manda un aviso de prueba a los celulares de esta sesión. */
export async function POST() {
  const session = await currentSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const results = await sendPushToSession(session.sessionId, testMessage());
  return Response.json({ sent: results.filter((r) => r === "sent").length, total: results.length });
}
