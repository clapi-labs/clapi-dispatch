import { zonesAt } from "@dispatch/shared";
import { listPriceZones } from "@dispatch/shared/db";

import { askBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

type Geocoded = { found: boolean; reason?: string; location?: { lat: number; lng: number }; neighborhood?: string | null };

const REASONS: Record<string, string> = {
  not_found: "El mapa no encontró esa dirección con precisión de puerta. Escríbela como la mandaría el restaurante.",
  failed: "El mapa no respondió. Intenta de nuevo en un momento.",
  disabled: "El bot no tiene configurado el mapa de Google.",
  no_bot: "El portal no tiene cómo hablar con el bot (BOT_URL o INTERNAL_SECRET).",
};

/**
 * «Probar una dirección» del mapa de precios por zona: con una dirección
 * escrita (la ubica el bot, igual que una entrega) o un punto del mapa,
 * responde en qué zonas cae y cuál manda, con su mínimo. Lee las zonas
 * guardadas, así que muestra lo mismo que cobraría la siguiente cotización.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { address?: unknown; lat?: unknown; lng?: unknown };

  let point: { lat: number; lng: number };
  let neighborhood: string | null = null;
  if (typeof body.address === "string" && body.address.trim()) {
    const geocoded = await askBot<Geocoded>("/api/internal/geocode", { address: body.address });
    if (!geocoded.ok) return Response.json({ error: REASONS[geocoded.reason] ?? "No se pudo consultar el bot." }, { status: 502 });
    if (!geocoded.data.found || !geocoded.data.location) {
      return Response.json({ error: REASONS[geocoded.data.reason ?? "not_found"] ?? REASONS.not_found }, { status: 404 });
    }
    point = geocoded.data.location;
    neighborhood = geocoded.data.neighborhood ?? null;
  } else {
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Response.json({ error: "Falta la dirección o el punto" }, { status: 400 });
    point = { lat, lng };
  }

  const zones = zonesAt(point, await listPriceZones()).map((z) => ({ id: z.id, name: z.name, minPrice: z.minPrice }));
  return Response.json({ point, neighborhood, zone: zones[0] ?? null, zones });
}
