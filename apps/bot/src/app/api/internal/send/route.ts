import { eq } from "drizzle-orm";

import { db, getBusinessState, schema } from "@dispatch/shared/db";

import { recordMessage } from "@/db/queries/conversation";
import { sendText } from "@/services/whatsapp/client";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/**
 * Un operador responde desde el portal (takeover). Pausa el bot en ese chat
 * —si la persona está escribiendo, el bot no puede contestar encima— y deja
 * el mensaje en el hilo con `role: "agent"`.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  const { conversationId, text } = (await request.json()) as { conversationId?: number; text?: string };
  const body = text?.trim();
  if (!conversationId || !body) return Response.json({ error: "Falta conversationId o text" }, { status: 400 });

  const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  if (!conversation) return Response.json({ error: "No existe" }, { status: 404 });

  // En la pausa general la central escribe como en un WhatsApp normal: el
  // chat no queda intervenido y vuelve al bot cuando la agencia reanuda.
  if (!(await getBusinessState()).paused) {
    await db
      .update(schema.conversations)
      .set({ botPaused: true, escalationReason: conversation.escalationReason ?? "Un operador tomó la conversación." })
      .where(eq(schema.conversations.id, conversationId));
  }

  const result = await sendText(conversation.phone, body);
  await recordMessage(conversationId, "agent", body);

  return Response.json(result.ok ? { ok: true } : { ok: false, reason: result.reason }, { status: result.ok ? 200 : 502 });
}
