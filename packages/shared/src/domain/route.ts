import type { DemandLevel } from "./demand";
import { orderStops, type RouteStop, type StopKind } from "./phase";
import { normalizeName } from "./restaurant-identity";
import type { ReturnDebtReason } from "./return-debts";

/**
 * La ruta completa del domiciliario: las paradas de sus pedidos y los regresos
 * al restaurante por un pendiente (docs/FLUJO-DOMICILIARIO.md, «La ruta en los
 * mensajes», y docs/ALGORITMO.md, «Regresos al restaurante»). Lo que no
 * depende de la base: dónde entra un regreso, cuál es del mismo restaurante y
 * cómo se le escribe la ruta.
 */

// ---------------------------------------------------------------------------
// Dónde va un regreso
// ---------------------------------------------------------------------------

/**
 * Un regreso al restaurante: el grupo de pendientes del mismo domiciliario,
 * restaurante y motivo, que se hace en una sola vuelta. `id` es el pendiente
 * más viejo del grupo: con él se guarda la parada `B` en la ruta.
 */
export type ReturnStop = {
  id: number;
  reason: ReturnDebtReason;
  restaurantId: number | null;
  restaurantName: string;
  /** Si va en la ruta: el datáfono siempre; la plata, desde que se le pidió
   *  pasar a pagar (demanda baja con la moto libre, «Mandar ya» o porque
   *  recoge en ese restaurante). */
  inRoute: boolean;
};

/**
 * Las paradas pendientes en orden, regresos incluidos. Lo que el último plan
 * conoce va en su orden (`orderStops`). Un regreso que el plan todavía no
 * conocía entra así:
 *
 * - con demanda baja, apenas entregue lo que lleva encima y antes de la
 *   siguiente recogida (el datáfono lo necesita el restaurante);
 * - con demanda alta, al final.
 *
 * En los dos casos nunca con comida de un cliente a bordo. Es la misma regla
 * que usan los casos del engine (`ubicar_regreso` en apps/engine/casos.py).
 */
export function orderRoute(
  plan: RouteStop[] | null | undefined,
  trips: { id: number; stops: StopKind[] }[],
  returns: Pick<ReturnStop, "id" | "inRoute">[],
  level: DemandLevel,
): RouteStop[] {
  const routed = returns.filter((r) => r.inRoute);
  const all = orderStops(plan, [...trips, ...routed.map((r) => ({ id: r.id, stops: ["B" as StopKind] }))]);
  const known = (s: RouteStop) => plan?.some((p) => p.tipo === s.tipo && p.pedido === s.pedido) ?? false;
  const fresh = all.filter((s) => s.tipo === "B" && !known(s));
  if (level === "alta" || !fresh.length) return all;

  const route = all.filter((s) => !fresh.includes(s));
  const at = firstEmptyHanded(route);
  return [...route.slice(0, at), ...fresh, ...route.slice(at)];
}

/** La primera posición en que no lleva comida de nadie: lo que ya recogió se
 *  entrega antes. */
function firstEmptyHanded(route: RouteStop[]): number {
  const picks = new Set(route.filter((s) => s.tipo === "R").map((s) => s.pedido));
  const aboard = new Set(route.filter((s) => s.tipo === "C" && !picks.has(s.pedido)).map((s) => s.pedido));
  for (const [i, s] of route.entries()) {
    if (!aboard.size) return i;
    if (s.tipo === "R") aboard.add(s.pedido);
    if (s.tipo === "C") aboard.delete(s.pedido);
  }
  return route.length;
}

/** El regreso es al restaurante donde recoge: por su id si los dos lo tienen,
 *  si no por el nombre, sin tildes ni mayúsculas. */
export function sameRestaurant(
  a: { restaurantId: number | null; restaurantName: string },
  b: { restaurantId: number | null; restaurantName: string },
): boolean {
  if (a.restaurantId !== null && b.restaurantId !== null) return a.restaurantId === b.restaurantId;
  const name = normalizeName(a.restaurantName);
  return name.length > 0 && name === normalizeName(b.restaurantName);
}

// ---------------------------------------------------------------------------
// Cómo se le escribe
// ---------------------------------------------------------------------------

/** Una parada con lo que hace falta para escribirla. */
export type RouteLine =
  | { tipo: "R" | "C" | "W" | "V"; code: string; restaurant: string; zone: string | null }
  | { tipo: "B"; reason: ReturnDebtReason; restaurant: string };

/** «Recoge A-08 en Donde Lucho», «Devuelve el datáfono en Donde Lucho». */
export function routeLineText(line: RouteLine): string {
  if (line.tipo === "B") return line.reason === "datafono" ? `Devuelve el datáfono en ${line.restaurant}` : `Paga en ${line.restaurant}`;
  const zone = line.zone ? ` (${line.zone})` : "";
  switch (line.tipo) {
    case "R":
      return `Recoge ${line.code} en ${line.restaurant}`;
    case "C":
      return `Entrega ${line.code}${zone}`;
    case "W":
      return `Espera al cliente de ${line.code}${zone}`;
    case "V":
      return `Devuelve ${line.code} en ${line.restaurant}`;
  }
}

/** Cuántas cosas distintas tiene por hacer: cada pedido (recoger y entregar
 *  son uno) y cada regreso. */
function errands(lines: RouteLine[]): number {
  return new Set(lines.map((l) => (l.tipo === "B" ? `B:${l.reason}:${l.restaurant}` : `T:${l.code}`))).size;
}

/**
 * La ruta al principio de cada mensaje al domiciliario, con lo que sigue
 * marcado. Con un solo pedido y nada más («Recoge A-07 → Entrega A-07») el
 * mensaje ya dice lo mismo: `null`. Sale desde dos cosas por hacer, regresos
 * incluidos («Entrega A-07 → Devuelve el datáfono»).
 *
 *     🧭 *Tu ruta:*
 *     1. ➡️ Entrega A-07 (San Fernando)
 *     2. Recoge A-08 en Donde Lucho
 *     3. Entrega A-08 (El Peñón)
 *     4. Devuelve el datáfono en La Brasa
 */
export function routeText(lines: RouteLine[]): string | null {
  if (lines.length < 2 || errands(lines) < 2) return null;
  return ["🧭 *Tu ruta:*", ...lines.map((l, i) => `${i + 1}. ${i === 0 ? "➡️ " : ""}${routeLineText(l)}`)].join("\n");
}

/** «♻️ Aprovecha y devuelve el datáfono en Donde Lucho»: recoge donde tiene un
 *  pendiente y lo hace en la misma vuelta. */
export function sameTripReturnText(reasons: ReturnDebtReason[], restaurant: string): string | null {
  const datafono = reasons.includes("datafono");
  const plata = reasons.includes("plata");
  if (!datafono && !plata) return null;
  const what = datafono && plata ? "devuelve el datáfono y paga" : datafono ? "devuelve el datáfono" : "paga";
  return `♻️ *Aprovecha y ${what} en ${restaurant}.*`;
}

/** Con demanda baja y la moto libre: que pase a pagar lo que debe. */
export function idlePayText(restaurant: string, codes: string): string {
  return `💵 Aprovecha: pasa por ${restaurant} a pagar${codes ? ` (${codes})` : ""}. Cuando lo hagas, toca «Ya pagué».`;
}
