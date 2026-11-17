import { eq } from "drizzle-orm";

import { createLiveRouterFromEnv } from "../domain/google-routes";
import { createRoadRouter, straightRouteKm, type RoadDistance, type RoadRouter, type RoadSource } from "../domain/road-distance";
import type { GeoPoint } from "../domain/dispatch/types";
import { db } from "./client";
import { adjustmentZoneAt, fareBreakdown, type FareBreakdown, type PricedZone } from "../domain/fare";
import { serviceVerdictAt } from "../domain/service-zones";
import { getFareRanges } from "./fares";
import { settings } from "./schema";
import { listServiceZones } from "./service-zones";

export { ROUTE_FACTOR } from "../domain/road-distance";

export const ROUTING_CONFIG_KEY = "routing_config";

/**
 * Con qué se miden los km del domicilio (docs/DIRECCIONES-Y-ZONAS.md). Se
 * cambia en la base, sin redesplegar (docs/OPERACION.md, «Mapa de calles»).
 */
export type RoutingConfig = {
  /** `true`: km reales por calle (Google Routes en la cotización del bot, con respaldo
   *  al OSRM propio), para el precio y para los
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

/** Qué pasó con el punto de entrega: dentro, cerca del borde, fuera de las
 *  zonas, o sin zonas marcadas (no se restringe). */
export type QuoteCoverage = "ok" | "cerca" | "fuera" | "sin_zonas";

export type Quote = {
  /** Distancia por calles, con un decimal. 0 si `routable` es false. */
  km: number;
  /** De dónde salió `km`: Google Routes, OSRM, o línea recta × 1,3. */
  source: RoadSource;
  /** `false`: el punto queda fuera de las zonas o del mapa de calles, o no
   *  hay ruta hasta él. No se cotiza. */
  routable: boolean;
  /** Dónde cae la entrega respecto a las zonas de servicio. */
  coverage: QuoteCoverage;
  /** Lo que se cobra: tabla por km más el ajuste de la zona de la entrega,
   *  nunca menos de 0. `null` si la tabla está vacía o si no se cotiza. */
  price: number | null;
  /** De dónde sale `price` (tabla, ajuste, zona). `null` si no se cotiza. */
  breakdown: FareBreakdown | null;
};

/** Distancia estimada por calles entre dos puntos: Haversine × factor de ruta.
 *  Gratis y sin red. Es lo que se usaba siempre, y el respaldo de OSRM. */
export function routeKm(from: GeoPoint, to: GeoPoint): number {
  return straightRouteKm(from, to);
}

let osrm: RoadRouter | null = null;
/** Solo OSRM propio ($0), con respaldo a línea recta. Para lo masivo (tabla de
 *  ejemplos de Tarifas): nunca llama a Google. Uno por proceso: así recuerda
 *  si OSRM está caído entre cotizaciones. */
export function osrmRouter(): RoadRouter {
  osrm ??= createRoadRouter({ url: process.env.OSRM_URL ?? "" });
  return osrm;
}

let live: RoadRouter | null = null;
/** Cotización en vivo: Google Routes → OSRM → línea recta × 1,3. Sin
 *  `GOOGLE_MAPS_API_KEY` (el portal no la tiene) salta directo a OSRM. */
function liveRouter(): RoadRouter {
  live ??= createLiveRouterFromEnv(process.env);
  return live;
}

/** Los km del domicilio según el interruptor: por calle (Google, con respaldo a
 *  OSRM y luego a línea recta) o en línea recta × 1,3. Con `measurer` se mide
 *  solo con ese (los procesos masivos pasan `osrmRouter()`). */
export async function deliveryDistance(from: GeoPoint, to: GeoPoint, config?: RoutingConfig, measurer?: RoadRouter): Promise<RoadDistance> {
  const { porCalle } = config ?? (await getRoutingConfig());
  if (!porCalle) return { km: routeKm(from, to), source: "linea_recta", routable: true };
  return (measurer ?? liveRouter()).distance(from, to);
}

/**
 * `cotizar` del contrato con el despacho (docs/CONTRATO-BOT-DESPACHO.md): el
 * precio del domicilio (`domain/fare.ts`): la tabla por km de Tarifas más el
 * ajuste fijo de la zona de servicio donde queda la entrega. La tabla, las
 * zonas y el interruptor de km por calle se leen en cada cotización, así que un
 * cambio aplica desde la siguiente. Es lo mismo que usan la tabla de ejemplos
 * de Tarifas y «Probar un punto» de Zonas. Fuera de las zonas de servicio o
 * del mapa de calles no hay precio (`routable: false`).
 *
 * `zones`: las zonas de servicio, si quien llama ya las leyó.
 */
export async function quoteByDistance(from: GeoPoint, to: GeoPoint, opts: { zones?: PricedZone[] } = {}): Promise<Quote> {
  const [ranges, zones] = await Promise.all([getFareRanges(), opts.zones ?? listServiceZones()]);
  const verdict = serviceVerdictAt(to, zones);
  const coverage: QuoteCoverage = verdict.kind === "dentro" ? "ok" : verdict.kind;

  // Fuera de las zonas no hay servicio: ni siquiera se mide ni se cobra.
  if (coverage === "fuera") return { km: 0, source: "linea_recta", routable: false, coverage, price: null, breakdown: null };

  const distance = await deliveryDistance(from, to);
  // OSRM respondió que no hay ruta o que el punto está fuera de su mapa:
  // tampoco se cotiza (no se reemplaza por línea recta × 1,3).
  if (!distance.routable) return { ...distance, coverage, price: null, breakdown: null };

  const breakdown = fareBreakdown(distance.km, ranges, adjustmentZoneAt(to, zones));
  return { ...distance, coverage, price: breakdown?.total ?? null, breakdown };
}
