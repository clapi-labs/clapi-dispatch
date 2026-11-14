import { haversineKm } from "./dispatch/haversine";
import type { GeoPoint } from "./dispatch/types";

/**
 * Distancia por calle entre dos puntos, con el OSRM propio (docs/OPERACION.md,
 * «Mapa de calles (OSRM)»), y su respaldo: la línea recta × `ROUTE_FACTOR`.
 *
 * El respaldo por caída no es un error para nadie: el pedido sigue, el
 * restaurante no ve nada distinto y la caída queda en el registro del
 * contenedor (`[calles] …`). Si OSRM responde que no hay ruta, el punto no se
 * cotiza (`routable: false`). Pura salvo por `fetch` y el reloj, que se pueden
 * inyectar para probarla.
 */

/** La ruta por calles es ~30 % más larga que la línea recta. Mismo valor que
 *  `FACTOR_RUTA` del engine: es el cálculo de respaldo, y el de siempre con el
 *  interruptor apagado. */
export const ROUTE_FACTOR = 1.3;

/** Cuánto se espera a OSRM antes de usar el respaldo. En la misma máquina
 *  responde en pocos milisegundos; si tarda esto, algo anda mal. */
export const ROAD_TIMEOUT_MS = 800;

/** Tras una caída, cuánto se usa el respaldo sin volver a preguntar: si OSRM
 *  está caído, cada cotización no espera el tiempo límite. */
export const ROAD_RETRY_AFTER_MS = 30_000;

/** Si OSRM tiene que mover un punto más que esto para dejarlo sobre una calle,
 *  el punto está fuera del mapa cargado (o en medio de la nada): la ruta que
 *  daría no sirve y se usa el respaldo. */
export const MAX_SNAP_METERS = 500;

export type RoadSource = "calle" | "linea_recta";

export type RoadDistance = {
  /** Kilómetros, con un decimal. 0 si `routable` es false. */
  km: number;
  /** `calle`: lo midió OSRM. `linea_recta`: línea recta × 1,3 (interruptor
   *  apagado, o respaldo porque OSRM no respondió). */
  source: RoadSource;
  /** `false`: OSRM respondió que no hay ruta o que un punto queda fuera del
   *  mapa cargado. No es una caída: esa entrega no se cotiza. */
  routable: boolean;
};

const oneDecimal = (km: number) => Math.round(km * 10) / 10;

/** El cálculo de siempre: línea recta × factor de ruta. Gratis y sin red. */
export function straightRouteKm(from: GeoPoint, to: GeoPoint): number {
  return oneDecimal(haversineKm(from, to) * ROUTE_FACTOR);
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type RoadRouterOptions = {
  /** Base de OSRM, p. ej. `http://osrm:5000`. Vacía: siempre el respaldo. */
  url: string;
  timeoutMs?: number;
  retryAfterMs?: number;
  fetch?: Fetch;
  now?: () => number;
  log?: (message: string) => void;
};

/** OSRM respondió bien, pero esa ruta no sirve (sin ruta, punto fuera del
 *  mapa): no se cotiza, sin dar a OSRM por caído. */
class UnusableRoute extends Error {}

type OsrmRoute = {
  code?: string;
  message?: string;
  routes?: { distance?: number }[];
  waypoints?: { distance?: number }[];
};

/**
 * Un medidor de distancias por calle. Guarda solo si OSRM está caído (para no
 * esperar en cada cotización); los resultados no se guardan: en la misma
 * máquina medir de nuevo cuesta menos que buscar en una caché.
 */
export function createRoadRouter(options: RoadRouterOptions) {
  const timeoutMs = options.timeoutMs ?? ROAD_TIMEOUT_MS;
  const retryAfterMs = options.retryAfterMs ?? ROAD_RETRY_AFTER_MS;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  const base = options.url.replace(/\/+$/, "");
  /** Hasta cuándo no se le pregunta a OSRM. */
  let downUntil = 0;
  let down = false;

  async function measure(from: GeoPoint, to: GeoPoint): Promise<number> {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const response = await doFetch(`${base}/route/v1/driving/${coords}?overview=false&alternatives=false&steps=false`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as OsrmRoute | null;
    const detail = `HTTP ${response.status} ${body?.code ?? ""} ${body?.message ?? ""}`.trim();
    // 400 con código (NoRoute, NoSegment…): OSRM está sano, esa ruta no existe.
    if (response.status === 400 && body?.code) throw new UnusableRoute(detail);
    if (!response.ok || body?.code !== "Ok") throw new Error(detail);
    const meters = body.routes?.[0]?.distance;
    if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) throw new Error("respuesta sin distancia");
    const snap = Math.max(...(body.waypoints ?? []).map((w) => w.distance ?? 0), 0);
    if (snap > MAX_SNAP_METERS) throw new UnusableRoute(`un punto queda a ${Math.round(snap)} m de la calle más cercana del mapa`);
    return meters / 1000;
  }

  return {
    /** Kilómetros por calle de `from` a `to`. Si OSRM no responde, devuelve
     *  la línea recta × 1,3 (`routable: true`). Si OSRM dice que no hay ruta
     *  o que el punto está fuera del mapa, `routable: false`: no se cotiza. */
    async distance(from: GeoPoint, to: GeoPoint): Promise<RoadDistance> {
      const fallback: RoadDistance = { km: straightRouteKm(from, to), source: "linea_recta", routable: true };
      if (!base || now() < downUntil) return fallback;
      try {
        const km = await measure(from, to);
        if (down) log("[calles] OSRM volvió a responder: se cotiza otra vez por calle.");
        down = false;
        return { km: oneDecimal(km), source: "calle", routable: true };
      } catch (error) {
        const reason = error instanceof Error ? (error.name === "TimeoutError" ? `no respondió en ${timeoutMs} ms` : error.message) : String(error);
        if (error instanceof UnusableRoute) {
          log(`[calles] ${reason}: esa entrega no se cotiza (fuera del mapa de calles).`);
          return { km: 0, source: "linea_recta", routable: false };
        }
        if (!down) log(`[calles] OSRM falló (${reason}): se usa línea recta × ${ROUTE_FACTOR} y se reintenta en ${retryAfterMs / 1000} s.`);
        down = true;
        downUntil = now() + retryAfterMs;
        return fallback;
      }
    },
  };
}

export type RoadRouter = ReturnType<typeof createRoadRouter>;
