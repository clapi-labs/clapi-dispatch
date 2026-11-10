import { assignPendingTrips, purgeOldPositions, releaseIdleControls, simulatorEnabled } from "@dispatch/shared/db";

import { handleClosing } from "@/bot/closing";
import { closeCustomerWaits, notifyAssigned, remindCouriers } from "@/bot/notify";
import { runEngine } from "@/dispatch/engine";

import { isInternal } from "../auth";

export const dynamic = "force-dynamic";

/** Cada cuánto se borran las posiciones de más de 24 horas: no hace falta en cada tick. */
const PURGE_EVERY_MS = 10 * 60_000;
let lastPurge = 0;

/**
 * Lo que tiene que pasar "cada tanto" aunque nadie esté mirando. Lo llama el
 * worker (scripts/worker.mjs) cada pocos segundos: le da moto a los viajes
 * que quedaron esperando, avisa por WhatsApp, le recuerda al motorizado lo que
 * le falta marcar y corre el engine, que asigna o solo calcula según el modo.
 *
 * Es seguro llamarlo seguido y en paralelo: cada viaje se reclama con un
 * UPDATE condicional, así que dos ticks nunca asignan el mismo.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  // Con el engine al frente la cola no asigna nada, y al revés (`mode`).
  const assigned = [...(await assignPendingTrips()), ...(await runEngineSafely())];
  for (const id of assigned) {
    try {
      await notifyAssigned(id);
    } catch (error) {
      console.error(`[tick] no se pudo avisar del viaje ${id}:`, error);
    }
  }

  // A quien no ha salido o no ha recogido a tiempo, se le recuerda una vez.
  let reminded: number[] = [];
  try {
    reminded = await remindCouriers();
  } catch (error) {
    console.error("[tick] no se pudieron mandar los recordatorios:", error);
  }

  // Al cliente que no contestó ya se le esperó: el pedido se devuelve.
  try {
    await closeCustomerWaits();
  } catch (error) {
    console.error("[tick] no se pudieron cerrar las esperas:", error);
  }

  // Cierre de cada restaurante: el recordatorio antes de su hora límite y,
  // pasada, el pedido a medio armar ya no se recibe.
  try {
    await handleClosing();
  } catch (error) {
    console.error("[tick] no se pudo revisar el cierre de los restaurantes:", error);
  }

  // Simulador: el número de prueba cuya moto ya no tiene pedidos queda libre.
  if (simulatorEnabled()) {
    try {
      await releaseIdleControls();
    } catch (error) {
      console.error("[tick] no se pudieron soltar las motos simuladas:", error);
    }
  }

  // No se guarda el recorrido: las posiciones de más de 24 horas se borran.
  if (Date.now() - lastPurge >= PURGE_EVERY_MS) {
    lastPurge = Date.now();
    try {
      const purged = await purgeOldPositions();
      if (purged.couriers || purged.evaluations) console.log(`[tick] posiciones de más de 24 h borradas: ${purged.couriers} motos, ${purged.evaluations} evaluaciones`);
    } catch (error) {
      console.error("[tick] no se pudieron borrar las posiciones viejas:", error);
    }
  }

  return Response.json({ assigned, reminded });
}

/** Un engine caído no puede tumbar el tick: los pedidos siguen esperando. */
async function runEngineSafely(): Promise<number[]> {
  try {
    return await runEngine();
  } catch (error) {
    console.error("[tick] el engine falló:", error);
    return [];
  }
}
