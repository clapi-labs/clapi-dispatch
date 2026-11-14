import { insideRing, ringAreaM2, type LatLngPoint, type ServiceZoneShape } from "./service-zones";

/**
 * La tabla de ejemplos de Tarifas (docs/DIRECCIONES-Y-ZONAS.md, «Tabla de
 * ejemplos»): para cada zona de origen con restaurantes y cada zona de
 * destino, los km típicos. Los precios no se guardan aquí: el portal los
 * calcula con `fareBreakdown` y la tabla que se está editando.
 *
 * Los km se miden desde cada restaurante real de la zona de origen hasta el
 * centro de la zona de destino; el típico es la mediana, y se muestra también
 * el rango (mínimo–máximo).
 */

/** Un punto dentro de la zona, lo más cerca posible de su centro de masa. En
 *  una zona en forma de L el centro puede quedar por fuera: ahí se busca, en
 *  una cuadrícula, el punto de adentro más cercano a él. */
export function zoneCenter(ring: LatLngPoint[]): LatLngPoint {
  let lat = 0;
  let lng = 0;
  let weight = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const cross = a.lng * b.lat - b.lng * a.lat;
    lat += (a.lat + b.lat) * cross;
    lng += (a.lng + b.lng) * cross;
    weight += cross;
  }
  const average = { lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length, lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length };
  const center = weight ? { lat: lat / (3 * weight), lng: lng / (3 * weight) } : average;
  if (insideRing(center, ring)) return center;

  const lats = ring.map((p) => p.lat);
  const lngs = ring.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  let best: LatLngPoint | null = null;
  let bestD = Infinity;
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const p = { lat: minLat + ((maxLat - minLat) * (i + 0.5)) / (steps + 1), lng: minLng + ((maxLng - minLng) * (j + 0.5)) / (steps + 1) };
      if (!insideRing(p, ring)) continue;
      const d = (p.lat - center.lat) ** 2 + (p.lng - center.lng) ** 2;
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
  }
  return best ?? ring[0];
}

/** La zona de un restaurante: la más pequeña que lo contiene, o `null`. */
export function zoneOfPoint<Z extends ServiceZoneShape>(point: LatLngPoint, zones: Z[]): Z | null {
  return (
    zones
      .filter((z) => z.ring.length >= 3 && insideRing(point, z.ring))
      .map((z) => ({ z, area: ringAreaM2(z.ring) }))
      .sort((a, b) => a.area - b.area || a.z.id - b.z.id)[0]?.z ?? null
  );
}

/** La mediana, redondeada a una décima de km. */
export function medianKm(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 10) / 10;
}

/** Una fila de la tabla de ejemplos, sin precios. */
export type FareExample = {
  originZoneId: number;
  destinationZoneId: number;
  /** Cuántos restaurantes de la zona de origen se midieron. */
  restaurants: number;
  /** Mediana de los km de cada restaurante al centro de la zona de destino. */
  km: number;
  kmMin: number;
  kmMax: number;
};
