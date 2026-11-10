/**
 * Zonas de servicio (docs/DIRECCIONES-Y-ZONAS.md, «Zonas de servicio»): áreas
 * del mapa donde sí hay domicilio. La central marca solo esas; lo que queda
 * por fuera no tiene servicio.
 *
 * - Cuenta dónde se entrega, no dónde está el restaurante, y son las mismas
 *   para todos los restaurantes.
 * - Pueden cruzarse: la entrega está cubierta si cae en cualquiera.
 * - Sin ninguna zona marcada no se restringe nada (`sin_zonas`): así el
 *   servicio no se cae mientras la central las marca.
 * - No cambian el precio: el domicilio se cobra solo por km (tabla de Tarifas).
 */

export type LatLngPoint = { lat: number; lng: number };

export type ServiceZoneShape = {
  id: number;
  name: string;
  /** El contorno, en orden y sin repetir el primer punto. */
  ring: LatLngPoint[];
};

/** A menos de esto del borde de una zona, la central decide si se hace. */
export const NEAR_ZONE_M = 300;

export type ServiceVerdict<Z extends ServiceZoneShape> =
  /** No hay zonas marcadas: todo funciona como antes, sin restringir. */
  | { kind: "sin_zonas" }
  /** Dentro de una o más zonas (de la más pequeña a la más grande). */
  | { kind: "dentro"; zones: Z[] }
  /** Fuera de toda zona, pero a `NEAR_ZONE_M` o menos del borde de `zone`. */
  | { kind: "cerca"; zone: Z; distanceM: number }
  /** Fuera y lejos de toda zona. `zone` es la más cercana. */
  | { kind: "fuera"; zone: Z; distanceM: number };

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

/** Metros desde el punto hasta el borde más cercano del contorno (cerrado).
 *  Proyecta alrededor del punto: a la escala de una ciudad el error es mínimo. */
export function distanceToRingM(point: LatLngPoint, ring: LatLngPoint[]): number {
  if (!ring.length) return Infinity;
  const k = Math.cos(point.lat * RAD);
  const xy = ring.map((p) => [(p.lng - point.lng) * RAD * k * EARTH_M, (p.lat - point.lat) * RAD * EARTH_M]);
  let best = Infinity;
  for (let i = 0; i < xy.length; i++) {
    const [ax, ay] = xy[i];
    const [bx, by] = xy[(i + 1) % xy.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    // El punto es el origen: la proyección sobre el tramo, recortada a sus extremos.
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Qué pasa con una entrega en ese punto: dentro, cerca, fuera o sin zonas. */
export function serviceVerdictAt<Z extends ServiceZoneShape>(point: LatLngPoint, zones: Z[], nearM = NEAR_ZONE_M): ServiceVerdict<Z> {
  const usable = zones.filter((z) => z.ring.length >= 3);
  if (!usable.length) return { kind: "sin_zonas" };

  const inside = usable.filter((z) => insideRing(point, z.ring));
  if (inside.length) {
    const sorted = inside
      .map((z) => ({ z, area: ringAreaM2(z.ring) }))
      .sort((a, b) => a.area - b.area || a.z.id - b.z.id)
      .map(({ z }) => z);
    return { kind: "dentro", zones: sorted };
  }

  let zone = usable[0];
  let distanceM = Infinity;
  for (const z of usable) {
    const d = distanceToRingM(point, z.ring);
    if (d < distanceM || (d === distanceM && z.id < zone.id)) {
      zone = z;
      distanceM = d;
    }
  }
  return distanceM <= nearM ? { kind: "cerca", zone, distanceM } : { kind: "fuera", zone, distanceM };
}
