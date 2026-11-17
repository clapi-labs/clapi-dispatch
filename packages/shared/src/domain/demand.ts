/**
 * La demanda de la operación (docs/ALGORITMO.md, «Demanda»): alta o baja,
 * medida con lo que está pasando y no con el reloj. Decide el modo del
 * algoritmo (alta = pico, baja = valle) y la pueden consultar el bot y el
 * portal. Es una sola para toda la operación.
 *
 * Aquí solo está el cálculo, puro: la medición sale de la base en
 * `db/demand.ts` y el tick la corre cada pocos segundos.
 */

export type DemandLevel = "alta" | "baja";

/** Lo que dice la medición de este momento, antes de esperar a que se mantenga:
 *  `alta` pasa algún umbral de subida, `baja` está por debajo de la mitad de
 *  los dos, y `media` está entre medio y no mueve nada. El ritmo de pedidos
 *  solo cuenta con pocas motos libres (`FEW_FREE_FRACTION`). */
export type DemandSignal = "alta" | "media" | "baja";

/** Los números de un momento. Son los que se muestran y se guardan con cada cambio. */
export type DemandMetrics = {
  /** Pendientes sin moto cuya comida está lista o lo estará dentro del horizonte. */
  waiting: number;
  /** Pendientes con la comida para más tarde: no cuentan todavía. */
  scheduled: number;
  /** Pedidos que entraron en la ventana (sin los cancelados). */
  arrivals: number;
  windowMin: number;
  /** Conectadas: disponibles u ocupadas, activas. */
  connected: number;
  /** Conectadas con el GPS en vivo. */
  live: number;
  /** Las que cuentan para la operación: las de GPS en vivo; si ninguna lo tiene
   *  (operación sin GPS todavía), todas las conectadas. */
  counted: number;
  /** De las que cuentan, las que no llevan ningún pedido. */
  free: number;
};

/** Los umbrales. Se cambian desde el portal; el siguiente cálculo ya los usa. */
export type DemandConfig = {
  /** Sube si los pedidos esperando llegan a esto por cada moto libre… */
  waitingPerFree: number;
  /** …y como mínimo a esto: un pedido suelto no la sube. */
  minWaiting: number;
  /** O si los pedidos que entraron en la ventana llegan a esto por cada moto que cuenta… */
  arrivalsPerCourier: number;
  /** …y como mínimo a esto. */
  minArrivals: number;
  /** La ventana para contar los pedidos que entran, en minutos. */
  windowMin: number;
  /** Un pendiente cuenta como esperando si su comida está lista dentro de estos minutos. */
  horizonMin: number;
  /** Minutos seguidos en alta para subir. */
  riseMin: number;
  /** Minutos seguidos en baja para bajar. */
  fallMin: number;
};

export const DEFAULT_DEMAND_CONFIG: DemandConfig = {
  waitingPerFree: 2,
  minWaiting: 3,
  arrivalsPerCourier: 1,
  minArrivals: 4,
  windowMin: 15,
  horizonMin: 10,
  riseMin: 3,
  fallMin: 10,
};

/** Para bajar, las dos señales tienen que estar por debajo de esta parte del
 *  umbral de subida. El hueco entre las dos es lo que evita que cambie a cada rato. */
export const FALL_FRACTION = 0.5;

/** Si el tick deja de medir más que esto, lo que venía acumulando no cuenta:
 *  no se sabe qué pasó en el hueco. */
export const MAX_GAP_MS = 60_000;

/** Los umbrales de subida con los números de este momento. */
export function demandThresholds(m: Pick<DemandMetrics, "free" | "counted">, c: DemandConfig) {
  return {
    waiting: Math.max(c.minWaiting, c.waitingPerFree * m.free),
    arrivals: Math.max(c.minArrivals, c.arrivalsPerCourier * Math.max(1, m.counted)),
  };
}

/** El ritmo de pedidos solo pesa con pocas motos libres: esta parte de las que
 *  cuentan, o menos. Con muchas libres los pedidos que entran se atienden en
 *  seguida, aunque la ventana todavía los cuente. */
export const FEW_FREE_FRACTION = 0.5;

const fewFree = (m: Pick<DemandMetrics, "free" | "counted">) => m.free <= m.counted * FEW_FREE_FRACTION;

export function demandSignal(m: DemandMetrics, c: DemandConfig): DemandSignal {
  const up = demandThresholds(m, c);
  const busyRate = fewFree(m) && m.arrivals >= up.arrivals;
  if (m.waiting >= up.waiting || busyRate) return "alta";
  const calmRate = !fewFree(m) || m.arrivals < up.arrivals * FALL_FRACTION;
  if (m.waiting < up.waiting * FALL_FRACTION && calmRate) return "baja";
  return "media";
}

export type DemandState = {
  level: DemandLevel;
  /** Desde cuándo está en este nivel. */
  since: Date;
  /** Desde cuándo la medición pide el otro nivel, sin cortarse. Nulo si no lo pide. */
  candidateSince: Date | null;
  /** La última medición: si quedó muy atrás, lo acumulado no cuenta. */
  measuredAt: Date | null;
};

export const INITIAL_DEMAND_STATE = (now: Date): DemandState => ({ level: "baja", since: now, candidateSince: null, measuredAt: null });

const other = (level: DemandLevel): DemandLevel => (level === "alta" ? "baja" : "alta");

/**
 * Un paso: con la medición de ahora, el estado que sigue. Cambia de nivel solo
 * si la medición pidió el otro sin cortarse durante `riseMin` (para subir) o
 * `fallMin` (para bajar). Un momento en el que no lo pide vuelve a empezar la cuenta.
 */
export function stepDemand(
  state: DemandState,
  metrics: DemandMetrics,
  config: DemandConfig,
  now: Date,
): { state: DemandState; signal: DemandSignal; changed: boolean } {
  const signal = demandSignal(metrics, config);
  const wanted = other(state.level);
  const gap = state.measuredAt ? now.getTime() - state.measuredAt.getTime() : Infinity;

  if (signal !== wanted) return { state: { ...state, candidateSince: null, measuredAt: now }, signal, changed: false };

  const candidateSince = state.candidateSince && gap <= MAX_GAP_MS ? state.candidateSince : now;
  const needMs = (wanted === "alta" ? config.riseMin : config.fallMin) * 60_000;
  if (now.getTime() - candidateSince.getTime() >= needMs) {
    return { state: { level: wanted, since: now, candidateSince: null, measuredAt: now }, signal, changed: true };
  }
  return { state: { ...state, candidateSince, measuredAt: now }, signal, changed: false };
}

/** Si la medición viene pidiendo el otro nivel: cuál y cuántos minutos le faltan. */
export function pendingDemandChange(state: Pick<DemandState, "level" | "candidateSince">, config: DemandConfig, now: Date) {
  if (!state.candidateSince) return null;
  const to = other(state.level);
  const needMs = (to === "alta" ? config.riseMin : config.fallMin) * 60_000;
  const leftMs = Math.max(0, needMs - (now.getTime() - state.candidateSince.getTime()));
  return { to, minutesLeft: Math.ceil(leftMs / 60_000) };
}

/** El modo del algoritmo que corresponde a cada nivel. */
export const modeForDemand = (level: DemandLevel): "pico" | "valle" => (level === "alta" ? "pico" : "valle");

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** El porqué, como lo lee la central: «5 pedidos esperando, 1 moto libre · 7 entraron en 15 min con 3 motos». */
export function demandSummary(m: DemandMetrics) {
  const waiting = `${plural(m.waiting, "pedido esperando", "pedidos esperando")}, ${plural(m.free, "moto libre", "motos libres")}`;
  const arrivals = `${plural(m.arrivals, "entró", "entraron")} en ${m.windowMin} min con ${plural(m.counted, "moto", "motos")}`;
  return `${waiting} · ${arrivals}`;
}

/** Revisa los umbrales que manda el portal. */
export function validateDemandConfig(body: unknown): { config: DemandConfig } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const fields: { key: keyof DemandConfig; label: string; min: number; max: number; integer: boolean }[] = [
    { key: "waitingPerFree", label: "Pedidos esperando por moto libre", min: 0.5, max: 20, integer: false },
    { key: "minWaiting", label: "Mínimo de pedidos esperando", min: 1, max: 100, integer: true },
    { key: "arrivalsPerCourier", label: "Pedidos que entran por moto", min: 0.5, max: 20, integer: false },
    { key: "minArrivals", label: "Mínimo de pedidos que entran", min: 1, max: 200, integer: true },
    { key: "windowMin", label: "Ventana de pedidos que entran", min: 5, max: 60, integer: true },
    { key: "horizonMin", label: "Horizonte de comida lista", min: 0, max: 60, integer: true },
    { key: "riseMin", label: "Minutos para subir", min: 0, max: 60, integer: true },
    { key: "fallMin", label: "Minutos para bajar", min: 0, max: 120, integer: true },
  ];
  const config = { ...DEFAULT_DEMAND_CONFIG };
  for (const f of fields) {
    const value = typeof b[f.key] === "string" ? Number(String(b[f.key]).replace(",", ".")) : b[f.key];
    if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${f.label}: falta un número` };
    if (f.integer && !Number.isInteger(value)) return { error: `${f.label}: debe ser un número entero` };
    if (value < f.min || value > f.max) return { error: `${f.label}: entre ${f.min} y ${f.max}` };
    config[f.key] = value;
  }
  return { config };
}

/** Lo guardado, con los valores por defecto en lo que falte o no sirva. */
export function normalizeDemandConfig(saved: unknown): DemandConfig {
  const config = { ...DEFAULT_DEMAND_CONFIG };
  const values = (saved ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(config) as (keyof DemandConfig)[]) {
    const checked = validateDemandConfig({ ...config, [key]: values[key] });
    if ("config" in checked) config[key] = checked.config[key];
  }
  return config;
}
