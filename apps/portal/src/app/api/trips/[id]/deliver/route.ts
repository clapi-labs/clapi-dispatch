import { deliverTrip } from "@dispatch/shared/db";

import { notifyBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

/**
 * La entrega marcada desde el portal: el respaldo de la lista de WhatsApp del
 * motorizado. Mismo efecto: si no debe volver, la moto vuelve a la cola y toma
 * el siguiente pendiente si hay, y el bot avisa a quien corresponda.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tripId = Number((await params).id);
  const body = (await request.json().catch(() => ({}))) as { place?: unknown; returning?: unknown };
  const result = await deliverTrip(tripId, { place: body.place === "gate" ? "gate" : "customer", returning: body.returning === true });
  if (!result) return Response.json({ ok: false }, { status: 409 });

  await notifyBot({ delivered: [tripId], assigned: result.newlyAssigned });
  return Response.json({ ok: true });
}
