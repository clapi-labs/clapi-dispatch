import { positionTime } from "@dispatch/shared";

import { courierForDevice, recordPosition } from "@/bot/gps";

export const dynamic = "force-dynamic";

/** Una posición con más error que esto no sirve para saber si llegó. */
const MAX_ACCURACY_M = 100;

type Location = { timestamp?: unknown; coords?: { latitude?: unknown; longitude?: unknown; accuracy?: unknown } };
type Report = { id: string | null; lat: number; lng: number; at: Date; accuracy: number | null };

const number = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : NaN);

function time(value: unknown) {
  const raw = number(value);
  // Traccar la manda en segundos o en texto ISO, según la versión.
  const date = Number.isFinite(raw) ? new Date(raw < 1e12 ? raw * 1000 : raw) : typeof value === "string" ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** Los dos formatos de Traccar Client: parámetros en la URL (protocolo OsmAnd) o
 *  JSON, en las versiones nuevas. */
async function readReport(request: Request): Promise<Report> {
  const params = new URL(request.url).searchParams;
  if (params.has("lat")) {
    return {
      id: params.get("id") ?? params.get("deviceid"),
      lat: number(params.get("lat")),
      lng: number(params.get("lon")),
      at: time(params.get("timestamp")),
      accuracy: params.has("accuracy") ? number(params.get("accuracy")) : null,
    };
  }
  const body = (await request.json().catch(() => null)) as {
    device_id?: string;
    location?: Location | Location[];
  } | null;
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

/**
 * Recibe la ubicación de los motorizados. Es pública porque le escriben sus
 * celulares: el identificador aleatorio de cada uno es lo que autoriza, y los que
 * no se conocen se descartan. Se responde 200 a lo que no sirve: si no, Traccar
 * reintenta para siempre un reporte que nunca va a servir.
 */
async function handle(request: Request) {
  const report = await readReport(request);
  const valid = report.id && Math.abs(report.lat) <= 90 && Math.abs(report.lng) <= 180;
  if (!valid) return new Response("OK", { status: 200 });

  const courier = await courierForDevice(report.id!);
  if (!courier) return new Response("OK", { status: 200 });

  if (report.accuracy === null || report.accuracy <= MAX_ACCURACY_M) {
    // Hora del servidor si el reloj del celular está cerca: un celular atrasado
    // no puede contar como sin señal, ni uno adelantado dejar la moto «en vivo».
    const at = positionTime(report.at, new Date());
    await recordPosition(courier.id, { lat: report.lat, lng: report.lng }, at);
  }
  return new Response("OK", { status: 200 });
}

export const GET = handle;
export const POST = handle;
