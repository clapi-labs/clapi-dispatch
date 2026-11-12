/**
 * Lo que manda Traccar Client, en sus tres formatos (docs/FLUJO-DOMICILIARIO.md,
 * fase 5): el protocolo OsmAnd con los datos en la URL o en el cuerpo del POST
 * (la versión nueva de la app los manda en el cuerpo), o JSON.
 */

type Location = { timestamp?: unknown; coords?: { latitude?: unknown; longitude?: unknown; accuracy?: unknown } };
export type Report = { id: string | null; lat: number; lng: number; at: Date; accuracy: number | null };

const number = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN);

function time(value: unknown) {
  const raw = number(value);
  // Traccar la manda en segundos, en milisegundos o en texto ISO, según la versión.
  const date = Number.isFinite(raw) ? new Date(raw < 1e12 ? raw * 1000 : raw) : typeof value === "string" ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function fromParams(params: URLSearchParams): Report {
  return {
    id: params.get("id") ?? params.get("deviceid"),
    lat: number(params.get("lat")),
    lng: number(params.get("lon")),
    at: time(params.get("timestamp")),
    accuracy: params.has("accuracy") ? number(params.get("accuracy")) : null,
  };
}

function fromJson(body: { device_id?: string; location?: Location | Location[] } | null): Report {
  // Al recuperar la señal pueden llegar varias juntas: la última es la que vale.
  const location = Array.isArray(body?.location) ? body.location.at(-1) : body?.location;
  const coords = location?.coords;
  return {
    id: body?.device_id ?? null,
    lat: number(coords?.latitude),
    lng: number(coords?.longitude),
    at: time(location?.timestamp),
    accuracy: coords?.accuracy === undefined ? null : number(coords.accuracy),
  };
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
