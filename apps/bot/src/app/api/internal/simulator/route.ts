import { ensureSimulatedCouriers, simulatorEnabled } from "@dispatch/shared/db";

import { actFor, simulatorState } from "@/simulator/plan";
import { createSimulatedOrder } from "@/simulator/order";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/**
 * El simulador de staging (docs/OPERACION.md, «Simulador»). Sin
 * `SIMULATOR_ENABLED` no existe: responde 404.
 *
 * - `GET`: qué hace cada moto simulada. Lo pide el proceso de movimiento.
 * - `POST { action: "setup" }`: crea las motos si no hay ninguna.
 * - `POST { action: "act", courierId, tripId }`: toca el botón por una moto que
 *   se maneja sola, por el mismo camino que un toque de WhatsApp.
 * - `POST { action: "order", restaurantId, lat, lng, readyInMinutes }`: un
 *   pedido desde el mapa, sin WhatsApp.
 */
export async function GET(request: Request) {
  if (!simulatorEnabled()) return new Response("Not found", { status: 404 });
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await simulatorState());
}

export async function POST(request: Request) {
  if (!simulatorEnabled()) return new Response("Not found", { status: 404 });
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  if (body.action === "setup") return Response.json({ created: await ensureSimulatedCouriers() });

  if (body.action === "act") {
    const courierId = num(body.courierId);
    const tripId = num(body.tripId);
    if (courierId === null || tripId === null) return Response.json({ error: "Faltan courierId y tripId" }, { status: 400 });
    return Response.json({ pressed: await actFor(courierId, tripId) });
  }

  if (body.action === "order") {
    const restaurantId = num(body.restaurantId);
    const lat = num(body.lat);
    const lng = num(body.lng);
    const ready = num(body.readyInMinutes) ?? 0;
    if (restaurantId === null || lat === null || lng === null) return Response.json({ error: "Faltan el restaurante y el punto" }, { status: 400 });
    const result = await createSimulatedOrder({ restaurantId, lat, lng, readyInMinutes: Math.max(0, Math.min(180, Math.round(ready))) });
    return Response.json(result, { status: "error" in result ? 400 : 200 });
  }

  return Response.json({ error: "Acción desconocida" }, { status: 400 });
}
