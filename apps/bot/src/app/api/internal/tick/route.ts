import { assignPendingTrips } from "@dispatch/shared/db";

import { notifyAssigned } from "@/bot/notify";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/**
 * Lo que tiene que pasar "cada tanto" aunque nadie esté mirando. Lo llama el
 * worker (scripts/worker.mjs) cada pocos segundos: por ahora le da moto a los
 * viajes que quedaron esperando y avisa por WhatsApp.
 *
 * Es seguro llamarlo seguido y en paralelo: cada viaje se reclama con un
 * UPDATE condicional, así que dos ticks nunca asignan el mismo.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  const assigned = await assignPendingTrips();
  for (const id of assigned) {
    try {
      await notifyAssigned(id);
    } catch (error) {
      console.error(`[tick] no se pudo avisar del viaje ${id}:`, error);
    }
  }

  return Response.json({ assigned });
}
