import { haversineKm } from "@dispatch/shared";

/**
 * Lo que manda Traccar Client, en sus tres formatos (docs/FLUJO-DOMICILIARIO.md,
 * fase 5): el protocolo OsmAnd con los datos en la URL o en el cuerpo del POST
 * (la versión nueva de la app los manda en el cuerpo), o JSON.
 */

type Location = {
  timestamp?: unknown;
  is_moving?: unknown;
  activity?: { type?: unknown };
  coords?: { latitude?: unknown; longitude?: unknown; accuracy?: unknown; speed?: unknown };
};
export type Report = {
  id: string | null;
  lat: number;
  lng: number;
  at: Date;
  accuracy: number | null;
  speed: number | null;
  isMoving: boolean | null;
  activity: string | null;
};

const number = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN);
const bool = (value: unknown) => (typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : null);

function time(value: unknown) {
  const raw = number(value);
  // Traccar la manda en segundos, en milisegundos o en texto ISO, según la versión.
  const date = Number.isFinite(raw) ? new Date(raw < 1e12 ? raw * 1000 : raw) : typeof value === "string" ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function fromParams(params: URLSearchParams): Report {
  const speedRaw = params.has("speed") ? number(params.get("speed")) : NaN;
  return {
    id: params.get("id") ?? params.get("deviceid"),
    lat: number(params.get("lat")),
    lng: number(params.get("lon")),
    at: time(params.get("timestamp")),
    accuracy: params.has("accuracy") ? number(params.get("accuracy")) : null,
    speed: Number.isFinite(speedRaw) && speedRaw >= 0 ? speedRaw : null,
    isMoving: bool(params.get("is_moving")),
    activity: params.get("activity") || null,
  };
}

function fromJson(body: { device_id?: string; location?: Location | Location[] } | null): Report {
  // Al recuperar la señal pueden llegar varias juntas: la última es la que vale.
  const location = Array.isArray(body?.location) ? body.location.at(-1) : body?.location;
  const coords = location?.coords;
  const speedRaw = coords?.speed === undefined ? NaN : number(coords.speed);
  return {
    id: body?.device_id ?? null,
    lat: number(coords?.latitude),
    lng: number(coords?.longitude),
    at: time(location?.timestamp),
    accuracy: coords?.accuracy === undefined ? null : number(coords.accuracy),
    speed: Number.isFinite(speedRaw) && speedRaw >= 0 ? speedRaw : null,
    isMoving: bool(location?.is_moving),
    activity: typeof location?.activity?.type === "string" && location.activity.type ? location.activity.type : null,
  };
}

/** Metros mínimos entre reportes para contar como movimiento si no llegó `is_moving`/`speed`. */
const MOVE_THRESHOLD_M = 15;

/**
 * Si la moto se está moviendo (`true`) o quieta (`false`). Con `false`, el
 * sistema espera el stationary heartbeat de Traccar Client en vez de marcarla
 * «sin señal» a los 30 s. `null` si es el primer reporte y no trae indicador.
 */
export function reportIsMoving(
  report: Pick<Report, "lat" | "lng" | "speed" | "isMoving" | "activity">,
  previous: { lat: number | null; lng: number | null } | null,
): boolean | null {
  if (report.isMoving !== null) return report.isMoving;
  if (report.activity && report.activity !== "unknown") return report.activity !== "still";
  if (report.speed !== null) return report.speed > 0.5;
  if (previous && previous.lat !== null && previous.lng !== null) {
    return haversineKm({ lat: previous.lat, lng: previous.lng }, { lat: report.lat, lng: report.lng }) * 1000 >= MOVE_THRESHOLD_M;
  }
  return null;
}

export async function readReport(request: Request): Promise<Report> {
  const query = new URL(request.url).searchParams;
  if (query.has("lat")) return fromParams(query);

  // El cuerpo se lee como texto: la app no siempre manda el Content-Type que
  // corresponde a lo que va adentro.
  const body = (await request.text().catch(() => "")).trim();
  if (body.startsWith("{")) {
    try {
      return fromJson(JSON.parse(body));
    } catch {
      return fromJson(null);
    }
  }
  return fromParams(new URLSearchParams(body));
}
