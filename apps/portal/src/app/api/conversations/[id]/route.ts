import { getThread, getThreadPage, resumeBot, takeOver, type ThreadQuery } from "@/db/queries/conversations";
import { callBot } from "@/lib/bot";
import { readJsonObject } from "@/lib/json";

export const dynamic = "force-dynamic";

/** Un id o un tamaño de página: entero positivo, o nada. */
function positiveInt(raw: string | null): number | undefined | "invalid" {
  if (raw === null || raw === "") return undefined;
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : "invalid";
}

/**
 * El hilo. Con `?limit=`, `?before=` o `?after=` va por páginas
 * (`getThreadPage`: `{ messages, hasOlder, reset }`); sin ninguno, el hilo
 * entero como lista, que es lo que piden las pestañas abiertas desde antes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const conversationId = Number((await params).id);
  const search = new URL(request.url).searchParams;
  const limit = positiveInt(search.get("limit"));
  const before = positiveInt(search.get("before"));
  // `after=0` vale: es «desde el principio».
  const afterRaw = search.get("after");
  const after = afterRaw === "0" ? 0 : positiveInt(afterRaw);

  if (limit === undefined && before === undefined && after === undefined) {
    return Response.json(await getThread(conversationId));
  }
  if (limit === "invalid" || before === "invalid" || after === "invalid" || (before !== undefined && after !== undefined)) {
    return Response.json({ error: "Página inválida" }, { status: 400 });
  }
  const query: ThreadQuery = { limit, before, after };
  return Response.json(await getThreadPage(conversationId, query));
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
  const body = (await readJsonObject(request)) ?? {};

  if (body.action === "pause") {
    await takeOver(conversationId);
    return Response.json({ ok: true });
  }
  if (body.action === "resume") {
    await resumeBot(conversationId, { onlyIfTakeover: body.onlyIfTakeover === true });
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
