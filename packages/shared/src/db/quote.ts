import { eq } from "drizzle-orm";

import { createRoadRouter, straightRouteKm, type RoadDistance, type RoadRouter, type RoadSource } from "../domain/road-distance";
import type { GeoPoint } from "../domain/dispatch/types";
import { db } from "./client";
import { getFareRanges, priceForDistance } from "./fares";
import { settings } from "./schema";

export { ROUTE_FACTOR } from "../domain/road-distance";

export const ROUTING_CONFIG_KEY = "routing_config";

/**
 * Con qué se miden los km del domicilio (docs/DIRECCIONES-Y-ZONAS.md). Se
 * cambia en la base, sin redesplegar (docs/OPERACION.md, «Mapa de calles»).
 */
export type RoutingConfig = {
  /** `true`: km reales por calle con el OSRM propio, para el precio y para los
   *  minutos del engine. `false` (por defecto): línea recta × 1,3, como
   *  siempre. Se enciende junto con la tabla de precios hecha para km por
   *  calle: con la tabla vieja todos los precios subirían de golpe. */
  porCalle: boolean;
};

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = { porCalle: false };

export async function getRoutingConfig(): Promise<RoutingConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, ROUTING_CONFIG_KEY));
  const saved = (row?.value ?? {}) as Partial<RoutingConfig>;
  return { porCalle: saved.porCalle === true };
}

export type Quote = {
  /** Distancia por calles, con un decimal. */
  km: number;
  /** De dónde salió `km`: OSRM, o línea recta × 1,3. */
  source: RoadSource;
  /** Lo que se cobra, según la tabla por km. `null` si la tabla está vacía:
   *  no hay con qué cobrar. */
  price: number | null;
};

/** Distancia estimada por calles entre dos puntos: Haversine × factor de ruta.
 *  Gratis y sin red. Es lo que se usaba siempre, y el respaldo de OSRM. */
export function routeKm(from: GeoPoint, to: GeoPoint): number {
  return straightRouteKm(from, to);
}

let router: RoadRouter | null = null;
/** Uno por proceso: así recuerda si OSRM está caído entre cotizaciones. */
function roadRouter(): RoadRouter {
  router ??= createRoadRouter({ url: process.env.OSRM_URL ?? "" });
  return router;
}

/** Los km del domicilio según el interruptor: por calle (con respaldo a línea
 *  recta si OSRM no responde) o en línea recta × 1,3. Nunca falla. */
export async function deliveryDistance(from: GeoPoint, to: GeoPoint, config?: RoutingConfig, measurer?: RoadRouter): Promise<RoadDistance> {
  const { porCalle } = config ?? (await getRoutingConfig());
  if (!porCalle) return { km: routeKm(from, to), source: "linea_recta" };
  return (measurer ?? roadRouter()).distance(from, to);
}

/**
 * `cotizar` del contrato con el despacho (docs/CONTRATO-BOT-DESPACHO.md): el
 * precio del domicilio por distancia, con la tabla de rangos que se edita en
 * el portal (Tarifas). Ninguna zona cambia el precio. La tabla y el
 * interruptor se leen en cada cotización, así que un cambio aplica desde la
 * siguiente.
 */
export async function quoteByDistance(from: GeoPoint, to: GeoPoint): Promise<Quote> {
  const [{ km, source }, ranges] = await Promise.all([deliveryDistance(from, to), getFareRanges()]);
  return { km, source, price: priceForDistance(km, ranges) };
}
