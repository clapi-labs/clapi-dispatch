import { serviceVerdictAt, type LatLngPoint, type ServiceZoneShape } from "./service-zones";

/**
 * El precio del domicilio (docs/DIRECCIONES-Y-ZONAS.md, «Precio del
 * domicilio»): la tabla por km de Tarifas más el ajuste fijo de la zona de
 * servicio donde queda la entrega. Puro, sin base: el bot, la tabla de
 * ejemplos de Tarifas y «Probar un punto» de Zonas usan exactamente esto.
 */

/**
 * Un tramo de la tabla por km: "hasta `upToKm` km cuesta `price`". Van de menor
 * a mayor y cada uno empieza donde termina el anterior. El último no tiene
 * tope (`upToKm: null`): "desde X km, `price` más `perKm` por cada km
 * adicional". Sin `perKm` (tablas de antes) el último es un precio fijo.
 */
export type FareRange = { upToKm: number | null; price: number; perKm?: number };

/** Tope del ajuste de una zona, en pesos (para arriba o para abajo). */
export const MAX_ZONE_ADJUSTMENT = 200_000;

const isPeso = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** La tabla válida, o `null` si no lo es: topes positivos y crecientes,
 *  precios enteros no negativos, y el último tramo sin tope. */
export function validateFareRanges(input: unknown): FareRange[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const ranges: FareRange[] = [];
  let previous = 0;
  for (let i = 0; i < input.length; i++) {
    const row = input[i] as { upToKm?: unknown; price?: unknown; perKm?: unknown };
    const last = i === input.length - 1;
    if (!isPeso(row?.price)) return null;
    if (last) {
      if (row.upToKm !== null) return null;
      if (row.perKm !== undefined && row.perKm !== null && !isPeso(row.perKm)) return null;
      ranges.push({ upToKm: null, price: row.price, perKm: isPeso(row.perKm) ? row.perKm : 0 });
    } else {
      if (typeof row.upToKm !== "number" || !Number.isFinite(row.upToKm)) return null;
      const km = Math.round(row.upToKm * 10) / 10; // una décima de km basta
      if (km <= previous) return null;
      previous = km;
      ranges.push({ upToKm: km, price: row.price });
    }
  }
  return ranges;
}

/** Décimas de km, enteras: así 6,2 − 4 no da 2,2000000001. */
const tenths = (km: number) => Math.round(km * 10);

/**
 * El precio de la tabla para una distancia: el primer tramo que la cubre
 * ("hasta 4 km" incluye los 4 km). Pasado el último tope, el precio del
 * último tramo más `perKm` por cada km adicional, contado por fracción: 4,1 km
 * ya paga uno. `null` si la tabla está vacía.
 */
export function priceForDistance(km: number, ranges: FareRange[]): number | null {
  if (!ranges.length) return null;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.upToKm !== null) {
      if (tenths(km) <= tenths(r.upToKm)) return r.price;
      continue;
    }
    const from = i === 0 ? 0 : (ranges[i - 1].upToKm ?? 0);
    const extraKm = Math.max(0, Math.ceil((tenths(km) - tenths(from)) / 10));
    return r.price + extraKm * (r.perKm ?? 0);
  }
  // Una tabla sin último tramo abierto (no la deja guardar `validateFareRanges`):
  // lo que pasa del último tope cuesta lo del último tramo.
  return ranges[ranges.length - 1].price;
}

/** El ajuste de una zona tal como llega del portal: entero en pesos, de
 *  −200.000 a 200.000. Vacío = 0. `null` si no sirve. */
export function validateFareAdjustment(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return 0;
  const n = typeof input === "string" ? Number(input.replace(/[.\s$]/g, "")) : input;
  if (!Number.isInteger(n) || Math.abs(n as number) > MAX_ZONE_ADJUSTMENT) return null;
  return (n as number) || 0; // sin −0
}

/** Una zona de servicio con su ajuste de precio. */
export type PricedZone = ServiceZoneShape & { fareAdjustment: number };

/**
 * De qué zona sale el ajuste: la de la entrega, nunca la del restaurante.
 * - dentro de varias: la más pequeña (la más precisa);
 * - cerca del borde: la zona más cercana (si la central dice que sí, se
 *   cobra como esa zona);
 * - fuera y lejos, o sin zonas marcadas: ninguna.
 */
export function adjustmentZoneAt<Z extends PricedZone>(point: LatLngPoint, zones: Z[]): Z | null {
  const verdict = serviceVerdictAt(point, zones);
  if (verdict.kind === "dentro") return verdict.zones[0];
  if (verdict.kind === "cerca") return verdict.zone;
  return null;
}

/** Lo que se cobra y de dónde sale: lo que muestra Viajes y «Probar un punto». */
export type FareBreakdown = {
  km: number;
  /** El precio de la tabla por km. */
  table: number;
  /** El ajuste de la zona de la entrega (0 sin zona). */
  adjustment: number;
  /** La zona de donde salió el ajuste. */
  zone: { id: number; name: string } | null;
  /** Tabla + ajuste, nunca por debajo de 0. */
  total: number;
};

/** El precio de un domicilio de `km` a una entrega en `zone`. `null` si la
 *  tabla está vacía: no hay con qué cobrar. */
export function fareBreakdown(km: number, ranges: FareRange[], zone: { id: number; name: string; fareAdjustment: number } | null): FareBreakdown | null {
  const table = priceForDistance(km, ranges);
  if (table === null) return null;
  const adjustment = zone?.fareAdjustment ?? 0;
  return { km, table, adjustment, zone: zone ? { id: zone.id, name: zone.name } : null, total: Math.max(0, table + adjustment) };
}
