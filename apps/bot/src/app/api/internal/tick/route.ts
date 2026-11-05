import { assignPendingTrips } from "@dispatch/shared/db";

import { notifyAssigned, remindUnseen } from "@/bot/notify";
import { runShadow } from "@/dispatch/shadow";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/**
 * Lo que tiene que pasar "cada tanto" aunque nadie esté mirando. Lo llama el
 * worker (scripts/worker.mjs) cada pocos segundos: le da moto a los viajes
 * que quedaron esperando, avisa por WhatsApp, le recuerda al motorizado que
 * confirme que vio el pedido y corre el modo sombra del engine.
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

  // A quien no ha tocado «Vi el pedido» en unos minutos, se le recuerda.
  let reminded: number[] = [];
  try {
    reminded = await remindUnseen();
  } catch (error) {
    console.error("[tick] no se pudieron mandar los recordatorios:", error);
  }

  // Después de la asignación real, y sin poder romperla.
  try {
    await runShadow();
  } catch (error) {
    console.error("[tick] el modo sombra falló:", error);
  }

  return Response.json({ assigned, reminded });
}
