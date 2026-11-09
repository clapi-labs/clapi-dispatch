/**
 * Precio mínimo por zona de entrega (docs/DIRECCIONES-Y-ZONAS.md, «Precio
 * mínimo por zona»). Una zona es un área del mapa con un nombre y un mínimo;
 * el precio de un domicilio es el mayor entre lo que da la tabla por km y el
 * mínimo de la zona donde se entrega.
 *
 * - Solo cuenta dónde se entrega, no dónde se recoge, y es igual para todos
 *   los restaurantes.
 * - Si la entrega cae en dos zonas, manda la más pequeña: es la más
 *   específica («una parte de Ciudad Jardín con otro mínimo»).
 * - Una zona sin mínimo (`minPrice: null`) sirve para sacar una parte de una
 *   zona más grande: ahí se cobra solo por km.
 * - Sin zona, el precio es el de la tabla, igual que antes.
 */

export type LatLngPoint = { lat: number; lng: number };

export type PriceZoneShape = {
  id: number;
  name: string;
  /** Pesos. `null`: sin mínimo, se cobra lo de la tabla por km. */
  minPrice: number | null;
  /** El contorno, en orden y sin repetir el primer punto. */
  ring: LatLngPoint[];
};

const EARTH_M = 6_371_000;
const RAD = Math.PI / 180;

/** ¿El punto está dentro del contorno? (rayo; el borde exacto da igual). */
export function insideRing(point: LatLngPoint, ring: LatLngPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > point.lat !== b.lat > point.lat && point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng) {
      inside = !inside;
    }
  }
  return inside;
}

/** Área en m², proyectando alrededor del primer punto (basta para un barrio). */
export function ringAreaM2(ring: LatLngPoint[]): number {
  if (ring.length < 3) return 0;
  const k = Math.cos(ring[0].lat * RAD);
  const xy = ring.map((p) => [(p.lng - ring[0].lng) * RAD * k * EARTH_M, (p.lat - ring[0].lat) * RAD * EARTH_M]);
  let twice = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/** Todas las zonas donde cae el punto, de la más pequeña a la más grande. La
 *  primera es la que manda. */
export function zonesAt<Z extends PriceZoneShape>(point: LatLngPoint, zones: Z[]): Z[] {
  return zones
    .filter((z) => z.ring.length >= 3 && insideRing(point, z.ring))
    .map((z) => ({ z, area: ringAreaM2(z.ring) }))
    .sort((a, b) => a.area - b.area || a.z.id - b.z.id)
    .map(({ z }) => z);
}

/** La zona que manda en ese punto, o `null` si no cae en ninguna. */
export function zoneAt<Z extends PriceZoneShape>(point: LatLngPoint, zones: Z[]): Z | null {
  return zonesAt(point, zones)[0] ?? null;
}

/**
 * El precio final: el mayor entre la tabla por km y el mínimo de la zona.
 * `kmPrice` null (tabla vacía) se queda null: sin tabla no se cotiza, con o
 * sin zona, como hasta ahora.
 */
export function withZoneMinimum(kmPrice: number | null, zone: Pick<PriceZoneShape, "minPrice"> | null): number | null {
  if (kmPrice === null) return null;
  if (!zone || zone.minPrice === null) return kmPrice;
  return Math.max(kmPrice, zone.minPrice);
}
