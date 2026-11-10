/**
 * Qué pasa en un punto del mapa de zonas (docs/DIRECCIONES-Y-ZONAS.md): si cae
 * en una zona sin cobertura, ahí no se va, aunque también esté dentro de una
 * zona de precio mínimo (gana la roja). Si no, manda la zona de precio de
 * `zonesAt` (la más pequeña), y fuera de toda zona se cobra solo por km.
 *
 * Es lo que muestra «Probar» en el mapa. La cotización sigue usando solo el
 * precio (`zoneAt` + `withZoneMinimum`); que el bot rechace las zonas sin
 * cobertura es aparte.
 */

import { insideRing, ringAreaM2, zonesAt, type LatLngPoint, type PriceZoneShape } from "./price-zones";

export type CoverageZoneShape = { id: number; name: string; ring: LatLngPoint[] };

export type ZoneVerdict<R extends CoverageZoneShape, P extends PriceZoneShape> =
  /** Dentro de una zona sin cobertura (la más pequeña, si cae en varias). */
  | { kind: "sin_cobertura"; zone: R; priceZones: P[] }
  /** Dentro de una zona de precio con mínimo: la que manda. */
  | { kind: "minimo"; zone: P; priceZones: P[] }
  /** Se cobra solo por km: fuera de toda zona, o en una zona sin mínimo (`zone`). */
  | { kind: "km"; zone: P | null; priceZones: P[] };

export function zoneVerdictAt<R extends CoverageZoneShape, P extends PriceZoneShape>(
  point: LatLngPoint,
  coverageZones: R[],
  priceZones: P[],
): ZoneVerdict<R, P> {
  const prices = zonesAt(point, priceZones);
  const blocked = coverageZones
    .filter((z) => z.ring.length >= 3 && insideRing(point, z.ring))
    .sort((a, b) => ringAreaM2(a.ring) - ringAreaM2(b.ring) || a.id - b.id)[0];
  if (blocked) return { kind: "sin_cobertura", zone: blocked, priceZones: prices };
  const zone = prices[0] ?? null;
  if (zone && zone.minPrice !== null) return { kind: "minimo", zone, priceZones: prices };
  return { kind: "km", zone, priceZones: prices };
}
