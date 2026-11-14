import { NEAR_ZONE_M, serviceVerdictAt } from "@dispatch/shared";
import { db, getBotConfig, listServiceZones, quoteByDistance, schema } from "@dispatch/shared/db";
import { eq } from "drizzle-orm";

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
 * «Probar» del mapa de zonas: con una dirección escrita (la ubica el bot,
 * igual que una entrega) o un punto del mapa, responde qué pasa con una
 * entrega ahí (`serviceVerdictAt`): dentro de una zona, cerca del borde (la
 * central decide), lejos (no hay servicio) o sin zonas marcadas (no se
 * restringe nada). Lee las zonas guardadas: es lo que usaría el bot.
 *
 * Con `restaurantId`, también la cotización real desde ese restaurante
 * (`quoteByDistance`, la misma del bot): km, precio de la tabla, ajuste de la
 * zona y total. Fuera de las zonas no hay precio: el bot no lo toma. No crea
 * pedidos ni manda mensajes.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { address?: unknown; lat?: unknown; lng?: unknown; restaurantId?: unknown };

  let pickup: { lat: number; lng: number } | null = null;
  let restaurantName: string | null = null;
  if (body.restaurantId != null && body.restaurantId !== "") {
    const id = Number(body.restaurantId);
    const [restaurant] = Number.isInteger(id) ? await db.select().from(schema.restaurants).where(eq(schema.restaurants.id, id)).limit(1) : [];
    if (!restaurant) return Response.json({ error: "Ese restaurante ya no existe" }, { status: 404 });
    if (!restaurant.knownPickupLocation) return Response.json({ error: "Ese restaurante no tiene ubicación de recogida: ubícalo en Restaurantes." }, { status: 400 });
    pickup = restaurant.knownPickupLocation;
    restaurantName = restaurant.name;
  }

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

  const zones = await listServiceZones();
  const verdict = serviceVerdictAt(point, zones);
  const zoneOf = (z: { id: number; name: string }) => ({ id: z.id, name: z.name });
  // Lo mismo que hace el bot: fuera y lejos no se cotiza.
  let quote = null;
  if (pickup && verdict.kind !== "fuera") {
    const [q, config] = await Promise.all([quoteByDistance(pickup, point, { zones }), getBotConfig()]);
    quote = {
      restaurant: restaurantName,
      pickup,
      km: q.km,
      source: q.source,
      table: q.breakdown?.table ?? null,
      adjustment: q.breakdown?.adjustment ?? 0,
      zone: q.breakdown?.zone ?? null,
      total: q.price,
      maxKm: config.maxKm,
      overMaxKm: config.maxKm !== null && q.km > config.maxKm,
    };
  }
  return Response.json({
    quote,
    point,
    neighborhood,
    nearM: NEAR_ZONE_M,
    kind: verdict.kind,
    zones: verdict.kind === "dentro" ? verdict.zones.map(zoneOf) : [],
    nearest: verdict.kind === "cerca" || verdict.kind === "fuera" ? { ...zoneOf(verdict.zone), distanceM: Math.round(verdict.distanceM) } : null,
  });
}
