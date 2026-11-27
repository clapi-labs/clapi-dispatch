import { notifyAssigned, notifyCancelled, notifyCourierGpsConfig, notifyCourierRemoved, notifyDebtNudge, notifyDelivered, notifyErrandCreated, notifyUnassigned } from "@/bot/notify";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/**
 * El portal cambió el estado de uno o más viajes (asignó un pendiente al
 * liberarse una moto, o alguien marcó "Entregado" en el tablero o en la app
 * del motorizado) y le pide al bot que avise por WhatsApp.
 * - `debtNudge`: «Mandar ya» de un pendiente de regreso.
 * - `courierGps`: «Enviar por WhatsApp» los datos de Traccar Client (#53).
 * - `errandCreated`: la central creó encargos desde Conversaciones; se le
 *   confirma a cada restaurante con su código.
 * - `removedCourier`: la central lo quitó de la flota; se le avisa.
 * - `cancelled`: la central canceló viajes; se le avisa a la moto que lo
 *   llevaba y, si la central lo dejó marcado, al restaurante.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  const {
    assigned = [],
    delivered = [],
    unassigned = [],
    errandCreated = [],
    cancelled = [],
    debtNudge,
    courierGps,
    gpsUrl,
    removedCourier,
  } = (await request.json()) as {
    assigned?: number[];
    delivered?: number[];
    unassigned?: { tripId: number; courierId: number }[];
    errandCreated?: number[];
    cancelled?: { tripId: number; courierId: number | null; notifyRestaurant?: boolean }[];
    debtNudge?: number;
    courierGps?: number;
    gpsUrl?: string;
    removedCourier?: number;
  };

  if (typeof debtNudge === "number") {
    const sent = await notifyDebtNudge(debtNudge);
    return Response.json(sent ? { ok: true } : { ok: false, reason: "closed" }, { status: sent ? 200 : 409 });
  }

  if (typeof courierGps === "number") {
    const sent = await notifyCourierGpsConfig(courierGps, gpsUrl);
    if (sent.ok) return Response.json({ ok: true });
    const status = sent.reason === "outside_window" || sent.reason === "no_gps_id" ? 409 : sent.reason === "not_found" ? 404 : 502;
    return Response.json({ ok: false, reason: sent.reason }, { status });
  }

  if (typeof removedCourier === "number") {
    await notifyCourierRemoved(removedCourier);
    return Response.json({ ok: true });
  }

  for (const id of errandCreated) await notifyErrandCreated(id);
  for (const { tripId, courierId, notifyRestaurant } of cancelled) await notifyCancelled(tripId, courierId, { toRestaurant: notifyRestaurant !== false });
  for (const { tripId, courierId } of unassigned) await notifyUnassigned(tripId, courierId);
  for (const id of delivered) await notifyDelivered(id);
  for (const id of assigned) await notifyAssigned(id);

  return Response.json({ ok: true });
}
