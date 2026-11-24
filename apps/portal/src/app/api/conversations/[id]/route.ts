import { createErrandTrip, dismissErrand } from "@dispatch/shared/db";

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
 * - `errand`: el panel «Encargo» de un chat que el bot pasó por un encargo.
 *   Con `create: true` y `price` crea el viaje (pendiente, lo asigna la central
 *   en Viajes) y el bot le confirma al restaurante; con `create: false` no crea
 *   nada. En los dos casos el chat vuelve al bot. 409 si el chat ya no esperaba
 *   esa decisión.
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
  if (body.action === "errand" && body.create === false) {
    const result = await dismissErrand(conversationId);
    return result.ok ? Response.json({ ok: true }) : Response.json({ error: "Este chat ya no espera un encargo" }, { status: 409 });
  }
  if (body.action === "errand" && body.create === true) {
    // El precio es el que la central acordó con el restaurante: no se calcula ni se valida.
    const price = typeof body.price === "number" && Number.isFinite(body.price) && body.price >= 0 ? Math.round(body.price) : null;
    if (price === null) return Response.json({ error: "Falta el precio del encargo" }, { status: 400 });
    const result = await createErrandTrip(conversationId, price);
    if (!result.ok) return Response.json({ error: "Este chat ya no espera un encargo" }, { status: 409 });
    // El viaje ya quedó: si el WhatsApp no sale, igual está en Viajes.
    await callBot("/api/internal/notify", { errandCreated: [result.value.id] });
    return Response.json({ ok: true, tripId: result.value.id, code: result.value.code });
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
