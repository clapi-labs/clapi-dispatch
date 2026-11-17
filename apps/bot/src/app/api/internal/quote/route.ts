import { quoteByDistance } from "@dispatch/shared/db";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

const isPoint = (p: unknown): p is { lat: number; lng: number } =>
  typeof p === "object" && p !== null && Number.isFinite((p as { lat?: unknown }).lat) && Number.isFinite((p as { lng?: unknown }).lng);

/**
 * «Probar» de Zonas: el portal no tiene la llave de Google (solo el bot, y está
 * restringida a la IP del servidor), así que le pide la cotización al bot. Es
 * `quoteByDistance` tal cual, la misma de un pedido real: Google Routes con
 * respaldo a OSRM y a línea recta × 1,3. Una consulta, una llamada a Google.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  const { pickup, point } = (await request.json().catch(() => ({}))) as { pickup?: unknown; point?: unknown };
  if (!isPoint(pickup) || !isPoint(point)) return Response.json({ error: "Faltan pickup o point (lat, lng)" }, { status: 400 });

  return Response.json(await quoteByDistance({ lat: pickup.lat, lng: pickup.lng }, { lat: point.lat, lng: point.lng }));
}
