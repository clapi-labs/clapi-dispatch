import type { GeoPoint } from "./dispatch/types";
import { createRoadRouter, type RoadDistance, type RoadRouter, type RoadRouterOptions } from "./road-distance";

/**
 * Km del domicilio con Google Routes API, para las cotizaciones en vivo del
 * bot (docs/DIRECCIONES-Y-ZONAS.md, «Distancia por calle»). Cascada: Google →
 * OSRM propio → línea recta × 1,3. Ninguna caída frena un pedido: la
 * siguiente fuente responde y la caída queda en el registro (`[calles] …`).
 *
 * Solo el nivel Compute Routes Essentials (10.000 gratis al mes): `DRIVE`,
 * `TRAFFIC_UNAWARE` y solo `routes.distanceMeters`. No activar `TWO_WHEELER` ni
 * `TRAFFIC_AWARE_OPTIMAL`: son de otro nivel y cuestan de 3 a 10 veces más.
 *
 * Los resultados no se guardan: los Términos de Google Maps Platform prohíben
 * cachear distancias de ruta. Solo se recuerda si Google está caído.
 */

export const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

/** Cuánto se espera a Google antes de pasar a OSRM. */
export const GOOGLE_TIMEOUT_MS = 1500;

/** Tras una caída de Google, cuánto se usa el respaldo sin volver a preguntar. */
export const GOOGLE_RETRY_AFTER_MS = 30_000;

const oneDecimal = (km: number) => Math.round(km * 10) / 10;

/** De las rutas que devuelve Google (la principal y sus alternativas), la de
 *  menor distancia, en km con un decimal. `null` si no hay ninguna válida. */
export function shortestRouteKm(routes: { distanceMeters?: unknown }[] | undefined): number | null {
  const meters = (routes ?? []).map((r) => r.distanceMeters).filter((m): m is number => typeof m === "number" && Number.isFinite(m) && m >= 0);
  if (meters.length === 0) return null;
  return oneDecimal(Math.min(...meters) / 1000);
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type GoogleRoutesOptions = {
  /** `GOOGLE_MAPS_API_KEY`. Vacía: nunca se consulta Google. */
  apiKey: string;
  timeoutMs?: number;
  retryAfterMs?: number;
  fetch?: Fetch;
  now?: () => number;
  log?: (message: string) => void;
};

type GoogleRoutesBody = { routes?: { distanceMeters?: number }[]; error?: { message?: string; status?: string } };

/** Un cliente de Google Routes: `distance` devuelve los km, o `null` si no se
 *  pudo medir con Google (sin llave, caída, tiempo, o sin ruta de carro). */
export function createGoogleRoutes(options: GoogleRoutesOptions) {
  const timeoutMs = options.timeoutMs ?? GOOGLE_TIMEOUT_MS;
  const retryAfterMs = options.retryAfterMs ?? GOOGLE_RETRY_AFTER_MS;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  let downUntil = 0;
  let down = false;

  return {
    async distance(from: GeoPoint, to: GeoPoint): Promise<number | null> {
      if (!options.apiKey || now() < downUntil) return null;
      try {
        const response = await doFetch(GOOGLE_ROUTES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": options.apiKey, "X-Goog-FieldMask": "routes.distanceMeters" },
          body: JSON.stringify({
            origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
            destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
            travelMode: "DRIVE",
            routingPreference: "TRAFFIC_UNAWARE",
            computeAlternativeRoutes: true,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await response.json().catch(() => null)) as GoogleRoutesBody | null;
        if (!response.ok) throw new Error(`HTTP ${response.status} ${body?.error?.status ?? ""} ${body?.error?.message ?? ""}`.trim());
        if (down) log("[calles] Google Routes volvió a responder: se cotiza otra vez con Google.");
        down = false;
        const km = shortestRouteKm(body?.routes);
        // 200 sin ruta de carro: Google está sano, pero no sirve para este par.
        if (km === null) log("[calles] Google Routes no devolvió ruta de carro: se mide con OSRM.");
        return km;
      } catch (error) {
        const reason = error instanceof Error ? (error.name === "TimeoutError" ? `no respondió en ${timeoutMs} ms` : error.message) : String(error);
        if (!down) log(`[calles] Google Routes falló (${reason}): se usa OSRM y se reintenta en ${retryAfterMs / 1000} s.`);
        down = true;
        downUntil = now() + retryAfterMs;
        return null;
      }
    },
  };
}

export type GoogleRoutes = ReturnType<typeof createGoogleRoutes>;

/** El medidor de las cotizaciones en vivo: Google primero; si no responde, el
 *  OSRM propio, que a su vez cae a línea recta × 1,3. */
export function createLiveRouter(google: GoogleRoutes, osrm: RoadRouter): RoadRouter {
  return {
    async distance(from: GeoPoint, to: GeoPoint): Promise<RoadDistance> {
      const km = await google.distance(from, to);
      if (km !== null) return { km, source: "google", routable: true };
      return osrm.distance(from, to);
    },
  };
}

/** Atajo para el proceso: lee la llave y OSRM del entorno. */
export function createLiveRouterFromEnv(env: Record<string, string | undefined>, osrmOptions: Partial<RoadRouterOptions> = {}): RoadRouter {
  return createLiveRouter(createGoogleRoutes({ apiKey: env.GOOGLE_MAPS_API_KEY ?? "" }), createRoadRouter({ url: env.OSRM_URL ?? "", ...osrmOptions }));
}
