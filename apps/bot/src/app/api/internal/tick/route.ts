import { assignPendingTrips, purgeOldPositions, runDemand, releaseIdleControls, runPushAlerts, simulatorEnabled } from "@dispatch/shared/db";

import { handleClosing } from "@/bot/closing";
import { closeCustomerWaits, notifyAssigned, nudgeIdlePayments, remindClosingDebts, remindCouriers } from "@/bot/notify";
import { recordWorkerTick } from "@/db/queries/worker-heartbeat";
import { closeSimulatedDebts } from "@/simulator/plan";
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
 * le falta marcar, mide la demanda y corre el engine, que asigna o solo calcula
 * según el modo.
 * Al final manda al celular de la central las alertas del portal que acaban
 * de pasar (chat que pide ayuda, moto asignada, datáfono sin devolver), aunque nadie tenga el portal
 * abierto.
 *
 * Es seguro llamarlo seguido y en paralelo: cada viaje se reclama con un
 * UPDATE condicional, así que dos ticks nunca asignan el mismo.
 */
export async function POST(request: Request) {
  if (!isInternal(request)) return new Response("Unauthorized", { status: 401 });

  // Primero la demanda: el engine evalúa en este mismo tick con el modo que
  // sale de ella (alta = pico, baja = valle).
  try {
    await runDemand();
  } catch (error) {
    console.error("[tick] no se pudo medir la demanda:", error);
  }

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

  // Con demanda baja, quien quedó libre y debe plata: «Aprovecha: pasa por X a
  // pagar», una vez (docs/FLUJO-DOMICILIARIO.md, «Pendientes de regreso»).
  try {
    await nudgeIdlePayments();
  } catch (error) {
    console.error("[tick] no se pudo avisar la plata por pagar:", error);
  }

  // Unos minutos antes de que cierre un restaurante, quien le deba el datáfono
  // o la plata recibe «⏰ X cierra pronto: pasa a devolver / a pagar» (#61).
  try {
    await remindClosingDebts();
  } catch (error) {
    console.error("[tick] no se pudieron avisar los pendientes por cierre:", error);
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
    // La moto simulada que se maneja sola cierra su pendiente de regreso.
    try {
      await closeSimulatedDebts();
    } catch (error) {
      console.error("[tick] no se pudieron cerrar los pendientes simulados:", error);
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

  // Al final: así la moto que se acaba de asignar en este mismo tick ya avisa.
  let alerted = 0;
  try {
    alerted = (await runPushAlerts()).length;
  } catch (error) {
    console.error("[tick] no se pudieron mandar las alertas al celular:", error);
  }

  // La vuelta terminó: `/api/health` usa esta hora para saber si la
  // asignación sigue andando. Al final, para que un tick que falla antes no cuente.
  try {
    await recordWorkerTick();
  } catch (error) {
    console.error("[tick] no se pudo anotar la vuelta:", error);
  }

  return Response.json({ assigned, reminded, alerted });
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
