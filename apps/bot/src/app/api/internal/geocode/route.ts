import { geocodeAddress } from "@/services/google/geocode";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/**
 * «Probar una dirección» del mapa de precios por zona: el portal no tiene la
 * llave de Google, así que le pide al bot que ubique la dirección igual que
 * ubica una entrega (`geocodeAddress`). Así el punto del mapa es el mismo que
 * usaría la cotización. Una geocodificación por consulta.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  const { address } = (await request.json().catch(() => ({}))) as { address?: unknown };
  const text = typeof address === "string" ? address.trim().slice(0, 200) : "";
  if (!text) return Response.json({ error: "Falta la dirección" }, { status: 400 });

  const outcome = await geocodeAddress(text);
  if (outcome.kind !== "found") return Response.json({ found: false, reason: outcome.kind });
  return Response.json({ found: true, location: outcome.location, neighborhood: outcome.neighborhood ?? null });
}
