import { cancelTrip } from "@dispatch/shared/db";

import { callBot } from "@/lib/bot";
import { readJsonObject } from "@/lib/json";

export const dynamic = "force-dynamic";

/**
 * La central cancela un viaje abierto, domicilio o encargo (docs/INTERVENCION-MANUAL.md,
 * «Cancelar»). Pide el motivo, si se cobra el domicilio (el portal lo trae
 * marcado si la moto ya salió del restaurante) y si se le avisa al
 * restaurante. A la moto que lo llevaba se le avisa siempre. 409 si ya no
 * estaba abierto.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tripId = Number((await params).id);
  if (!Number.isInteger(tripId) || tripId <= 0) return Response.json({ error: "Viaje inválido" }, { status: 400 });
  const body = await readJsonObject(request);
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  if (!reason) return Response.json({ error: "Falta el motivo" }, { status: 400 });
  if (typeof body?.charge !== "boolean") return Response.json({ error: "Falta decir si se cobra el domicilio" }, { status: 400 });
  const notifyRestaurant = body?.notifyRestaurant !== false;

  const cancelled = await cancelTrip(tripId, { reason, charge: body.charge });
  if (!cancelled) return Response.json({ error: "Este viaje ya no está abierto: se entregó o ya se canceló" }, { status: 409 });

  // Si el bot no responde, la cancelación igual queda: los avisos son aparte.
  await callBot("/api/internal/notify", { cancelled: [{ tripId, courierId: cancelled.courierId, notifyRestaurant }] });
  return Response.json({ ok: true, charged: cancelled.charged });
}
