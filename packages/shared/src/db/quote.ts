import { haversineKm } from "../domain/dispatch/haversine";
import type { GeoPoint } from "../domain/dispatch/types";
import { getDefaultFare, getFareRanges, priceForDistance } from "./fares";

/** La ruta por calles es ~30 % más larga que la línea recta. Mismo valor que
 *  `FACTOR_RUTA` del engine, para que precio y asignación midan igual. */
export const ROUTE_FACTOR = 1.3;

export type Quote = {
  /** Distancia estimada por calles, con un decimal. */
  km: number;
  price: number;
  /** `ranges`: salió de la tabla por km. `default`: la tabla está vacía y se
   *  cobró la tarifa por defecto. */
  source: "ranges" | "default";
};

/** Distancia estimada por calles entre dos puntos: Haversine × factor de ruta.
 *  Gratis y sin red. */
export function routeKm(from: GeoPoint, to: GeoPoint): number {
  return Math.round(haversineKm(from, to) * ROUTE_FACTOR * 10) / 10;
}

/**
 * `cotizar` del contrato con el despacho (docs/CONTRATO-BOT-DESPACHO.md): el
 * precio del domicilio por distancia, con la tabla de rangos que se edita en
 * el portal. Si algún día el engine ofrece una distancia mejor, cambia el
 * interior de esta función, no su forma.
 */
export async function quoteByDistance(from: GeoPoint, to: GeoPoint): Promise<Quote> {
  const km = routeKm(from, to);
  const price = priceForDistance(km, await getFareRanges());
  if (price !== null) return { km, price, source: "ranges" };
  return { km, price: await getDefaultFare(), source: "default" };
}
