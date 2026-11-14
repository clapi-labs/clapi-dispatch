import { notifyAssigned, notifyDebtNudge, notifyDelivered, notifyUnassigned } from "@/bot/notify";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/**
 * El portal cambió el estado de uno o más viajes (asignó un pendiente al
 * liberarse una moto, o alguien marcó "Entregado" en el tablero o en la app
 * del motorizado) y le pide al bot que avise por WhatsApp. `debtNudge`: «Mandar
 * ya» de un pendiente de regreso: se le escribe al domiciliario que pase por el
 * restaurante.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  const {
    assigned = [],
    delivered = [],
    unassigned = [],
    debtNudge,
  } = (await request.json()) as { assigned?: number[]; delivered?: number[]; unassigned?: { tripId: number; courierId: number }[]; debtNudge?: number };

  if (typeof debtNudge === "number") {
    const sent = await notifyDebtNudge(debtNudge);
    return Response.json(sent ? { ok: true } : { ok: false, reason: "closed" }, { status: sent ? 200 : 409 });
  }

  for (const { tripId, courierId } of unassigned) await notifyUnassigned(tripId, courierId);
  for (const id of delivered) await notifyDelivered(id, assigned);
  for (const id of assigned) await notifyAssigned(id);

  return Response.json({ ok: true });
}
