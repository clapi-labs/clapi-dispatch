import { answerAdvisorQuery, type AdvisorAnswer } from "@/bot/advisor";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/**
 * El asesor respondió en el portal una consulta de dirección: si es válida y
 * cuánto vale. El bot retoma la conversación con el restaurante.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  const { conversationId, respuestas } = (await request.json().catch(() => ({}))) as { conversationId?: number; respuestas?: AdvisorAnswer[] };
  if (!conversationId || !Array.isArray(respuestas)) return Response.json({ error: "Falta conversationId o respuestas" }, { status: 400 });

  const result = await answerAdvisorQuery(conversationId, respuestas);
  return result.ok ? Response.json({ ok: true }) : Response.json({ ok: false, reason: result.error }, { status: result.status });
}
