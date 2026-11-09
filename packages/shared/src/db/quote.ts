import { haversineKm } from "../domain/dispatch/haversine";
import type { GeoPoint } from "../domain/dispatch/types";
import { withZoneMinimum, zoneAt } from "../domain/price-zones";
import { getFareRanges, priceForDistance } from "./fares";
import { listPriceZones } from "./price-zones";

/** La ruta por calles es ~30 % más larga que la línea recta. Mismo valor que
 *  `FACTOR_RUTA` del engine, para que precio y asignación midan igual. */
export const ROUTE_FACTOR = 1.3;

export type Quote = {
  /** Distancia estimada por calles, con un decimal. */
  km: number;
  /** Lo que se cobra: el mayor entre la tabla por km y el mínimo de la zona
   *  de entrega. `null` si la tabla por km está vacía: no hay con qué cobrar. */
  price: number | null;
  /** Lo que da solo la tabla por km. */
  kmPrice: number | null;
  /** La zona de precio donde cae la entrega (la más pequeña), si cae en una. */
  zone: { id: number; name: string; minPrice: number | null } | null;
};

/** Distancia estimada por calles entre dos puntos: Haversine × factor de ruta.
 *  Gratis y sin red. */
export function routeKm(from: GeoPoint, to: GeoPoint): number {
  return Math.round(haversineKm(from, to) * ROUTE_FACTOR * 10) / 10;
}

/**
 * `cotizar` del contrato con el despacho (docs/CONTRATO-BOT-DESPACHO.md): el
 * precio del domicilio por distancia, con la tabla de rangos que se edita en
 * el portal, y nunca menos que el mínimo de la zona donde se entrega
 * (`domain/price-zones.ts`). Tabla y zonas se leen en cada cotización, así
 * que un cambio en el portal aplica desde la siguiente. Si algún día el engine
 * ofrece una distancia mejor, cambia el interior de esta función, no su forma.
 */
export async function quoteByDistance(from: GeoPoint, to: GeoPoint): Promise<Quote> {
  const km = routeKm(from, to);
  const [ranges, zones] = await Promise.all([getFareRanges(), listPriceZones()]);
  const kmPrice = priceForDistance(km, ranges);
  const zone = zoneAt({ lat: to.lat, lng: to.lng }, zones);
  return {
    km,
    price: withZoneMinimum(kmPrice, zone),
    kmPrice,
    zone: zone ? { id: zone.id, name: zone.name, minPrice: zone.minPrice } : null,
  };
}
