import { getThread, resumeBot, takeOver } from "@/db/queries/conversations";
import { callBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json(await getThread(Number(id)));
}

/**
 * - `pause`: el operador toma el chat (el bot se calla en ese número).
 * - `resume`: se lo devuelve al bot.
 * - `send`: el operador escribe; sale por WhatsApp a través del bot.
 * - `address`: responde la consulta de dirección del bot (si es válida y
 *   cuánto vale); el bot retoma la conversación con el restaurante.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const conversationId = Number((await params).id);
  const body = await request.json().catch(() => ({}));

  if (body.action === "pause") {
    await takeOver(conversationId);
    return Response.json({ ok: true });
  }
  if (body.action === "resume") {
    await resumeBot(conversationId);
    return Response.json({ ok: true });
  }
  if (body.action === "address" && Array.isArray(body.respuestas)) {
    const result = await callBot("/api/internal/address", { conversationId, respuestas: body.respuestas });
    return Response.json(result, { status: result.ok ? 200 : 502 });
  }
  if (body.action === "send" && typeof body.text === "string" && body.text.trim()) {
    const result = await callBot("/api/internal/send", { conversationId, text: body.text.trim() });
    return Response.json(result, { status: result.ok ? 200 : 502 });
  }
  return Response.json({ error: "Acción inválida" }, { status: 400 });
}
