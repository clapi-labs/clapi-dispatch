import { deliverTrip } from "@dispatch/shared/db";

import { notifyBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

/**
 * La entrega marcada desde el portal: el respaldo de los botones de WhatsApp del
 * motorizado. Mismo efecto: el servicio termina, la moto vuelve a la cola y
 * toma el siguiente pendiente si hay, y el bot avisa a quien corresponda (y al
 * motorizado, cómo cerrar el pendiente de regreso que tenga con ese pedido).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tripId = Number((await params).id);
  const body = (await request.json().catch(() => ({}))) as { place?: unknown };
  const result = await deliverTrip(tripId, { place: body.place === "gate" ? "gate" : "customer" });
  if (!result) return Response.json({ ok: false }, { status: 409 });

  await notifyBot({ delivered: [tripId], assigned: result.newlyAssigned });
  return Response.json({ ok: true });
}
