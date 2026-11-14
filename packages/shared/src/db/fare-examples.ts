import { medianKm, zoneCenter, zoneOfPoint, type FareExample } from "../domain/fare-examples";
import type { RoadSource } from "../domain/road-distance";
import { listRestaurants } from "./restaurants";
import { deliveryDistance, getRoutingConfig } from "./quote";
import { listServiceZones } from "./service-zones";

/** Cuántas distancias se piden a OSRM a la vez. */
const PARALLEL = 8;

export type FareExamples = {
  /** Si el interruptor de km por calle está encendido (lo que usa el bot). */
  porCalle: boolean;
  /** Con qué se midieron: `calle` si el interruptor está encendido (y OSRM
   *  respondió), `linea_recta` si no. Si se mezclan, `calle` con avisos. */
  source: RoadSource;
  /** Cuántas medidas salieron en línea recta con el interruptor encendido
   *  (OSRM no respondió para ellas). */
  fallbacks: number;
  /** Las zonas, con su ajuste guardado, para el formulario. */
  zones: { id: number; name: string; fareAdjustment: number; restaurants: number }[];
  /** Restaurantes con ubicación que no quedan dentro de ninguna zona: no
   *  entran en la tabla. */
  restaurantsOutside: number;
  rows: FareExample[];
};

/**
 * Los km de la tabla de ejemplos de Tarifas, medidos igual que los mide el bot
 * (`deliveryDistance`: por calle si está encendido, línea recta × 1,3 si no):
 * de cada restaurante activo de una zona al centro de cada zona.
 *
 * `previewStreet`: medir por calle aunque el interruptor esté apagado, para
 * ver cómo quedan los precios antes de encenderlo junto con la tabla nueva.
 */
export async function fareExampleDistances(opts: { previewStreet?: boolean } = {}): Promise<FareExamples> {
  const [zones, restaurants, saved] = await Promise.all([listServiceZones(), listRestaurants(), getRoutingConfig()]);
  const config = opts.previewStreet ? { porCalle: true } : saved;
  const usable = zones.filter((z) => z.ring.length >= 3);
  const byZone = new Map<number, { lat: number; lng: number }[]>();
  let restaurantsOutside = 0;
  for (const r of restaurants) {
    if (!r.active || !r.knownPickupLocation) continue;
    const zone = zoneOfPoint(r.knownPickupLocation, usable);
    if (!zone) {
      restaurantsOutside++;
      continue;
    }
    byZone.set(zone.id, [...(byZone.get(zone.id) ?? []), r.knownPickupLocation]);
  }

  const centers = new Map(usable.map((z) => [z.id, zoneCenter(z.ring)]));
  const jobs: { origin: number; destination: number; from: { lat: number; lng: number } }[] = [];
  for (const [origin, points] of byZone) for (const z of usable) for (const from of points) jobs.push({ origin, destination: z.id, from });

  const km: number[] = new Array(jobs.length);
  let fallbacks = 0;
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      const d = await deliveryDistance(jobs[i].from, centers.get(jobs[i].destination)!, config);
      if (config.porCalle && d.source !== "calle") fallbacks++;
      km[i] = d.km;
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));

  const grouped = new Map<string, number[]>();
  jobs.forEach((job, i) => {
    const key = `${job.origin}:${job.destination}`;
    grouped.set(key, [...(grouped.get(key) ?? []), km[i]]);
  });
  const rows: FareExample[] = [...grouped].map(([key, values]) => {
    const [originZoneId, destinationZoneId] = key.split(":").map(Number);
    return { originZoneId, destinationZoneId, restaurants: values.length, km: medianKm(values), kmMin: Math.min(...values), kmMax: Math.max(...values) };
  });

  return {
    porCalle: saved.porCalle,
    source: config.porCalle ? "calle" : "linea_recta",
    fallbacks,
    zones: usable.map((z) => ({ id: z.id, name: z.name, fareAdjustment: z.fareAdjustment, restaurants: byZone.get(z.id)?.length ?? 0 })),
    restaurantsOutside,
    rows,
  };
}
