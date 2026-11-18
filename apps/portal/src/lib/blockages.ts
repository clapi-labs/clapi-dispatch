import type { Trip } from "@/lib/types";

/**
 * Qué bloqueos de viaje son críticos (🔴 en el celular): la moto no recoge, o
 * la entrega o la devolución se estancó. «Cliente no contesta» es naranja y no
 * hace sonar el timbre del portal.
 */
const CRITICAL = new Set(["pickup_late", "delivery_late", "return_late"]);

/** Los viajes con un bloqueo crítico que ya empezó. */
export function criticalBlockedIds(trips: Trip[], now = Date.now()): Set<number> {
  const ids = new Set<number>();
  for (const t of trips) {
    if (t.blockageKind && CRITICAL.has(t.blockageKind) && t.blockageAt && Date.parse(t.blockageAt) <= now) ids.add(t.id);
  }
  return ids;
}

/** Hay algún bloqueo crítico que no estaba antes. Se compara por id, no por
 *  cuántos hay: si uno se resuelve y otro empieza a la vez, igual suena. */
export function hasNewCritical(current: Set<number>, seen: Set<number> | null): boolean {
  if (seen === null) return false;
  for (const id of current) if (!seen.has(id)) return true;
  return false;
}
