import { env } from "@/env";

export type LatLng = { lat: number; lng: number };

/**
 * - `found`: la dirección quedó ubicada con precisión de puerta (o casi).
 * - `not_found`: Google no la encontró, o solo ubicó la calle, el barrio o
 *   algo fuera del área. Es un dato que el restaurante puede corregir.
 * - `failed`: red, cupo agotado o llave mala. No es culpa del restaurante.
 * - `disabled`: no hay `GOOGLE_MAPS_API_KEY` configurada.
 */
export type GeocodeOutcome =
  /** `neighborhood`: el barrio según Google, para nombrar la entrega. */
  | { kind: "found"; location: LatLng; neighborhood?: string | null }
  | { kind: "not_found" }
  | { kind: "failed" }
  | { kind: "disabled" };

const TIMEOUT_MS = 5_000;

/** Cali con Yumbo y Jamundí. Sesga la búsqueda hacia acá y descarta un "Cra
 *  15 # 32-10" que Google ubique en otra ciudad. */
const AREA = { south: 3.2, west: -76.65, north: 3.6, east: -76.4 };

/** ROOFTOP = la puerta; RANGE_INTERPOLATED = entre dos números conocidos de la
 *  cuadra. GEOMETRIC_CENTER y APPROXIMATE son el centro de una calle o de un
 *  barrio: para medir quién llega primero, eso no sirve. */
const PRECISE = new Set(["ROOFTOP", "RANGE_INTERPOLATED"]);

type GoogleGeocodeResponse = {
  status: string;
  error_message?: string;
  results?: {
    geometry: { location: LatLng; location_type: string };
    address_components?: { long_name: string; types: string[] }[];
  }[];
};

function insideArea({ lat, lng }: LatLng) {
  return lat >= AREA.south && lat <= AREA.north && lng >= AREA.west && lng <= AREA.east;
}

/** Pura: decide con la respuesta de Google, sin red. */
export function interpretGeocode(data: GoogleGeocodeResponse): GeocodeOutcome {
  if (data.status === "ZERO_RESULTS") return { kind: "not_found" };
  if (data.status !== "OK") return { kind: "failed" };
  const best = data.results?.find((r) => PRECISE.has(r.geometry.location_type) && insideArea(r.geometry.location));
  if (!best) return { kind: "not_found" };
  const neighborhood = best.address_components?.find((c) => c.types.includes("neighborhood") || c.types.includes("sublocality"))?.long_name ?? null;
  return { kind: "found", location: best.geometry.location, neighborhood };
}

/**
 * Ubicación de mentira para pruebas y demostraciones sin Google
 * (`GEOCODE_SIMULADO=true`; el chat de prueba la usa por defecto). La misma
 * dirección cae siempre en el mismo punto, dentro de Cali, a pocos km del
 * centro del sur. Nunca en producción: el precio saldría inventado.
 */
function simulatedLocation(address: string): LatLng {
  let hash = 0;
  for (const ch of address.toLowerCase().replace(/\s+/g, " ").trim()) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const a = ((hash >>> 0) % 1000) / 1000;
  const b = (((hash >>> 10) >>> 0) % 1000) / 1000;
  return { lat: 3.37 + (a - 0.5) * 0.08, lng: -76.53 + (b - 0.5) * 0.06 };
}

/** Un solo intento: si Google no responde, quien llama decide (hoy: pasa el
 *  pedido a la central, no se cobra sin ubicación). */
export async function geocodeAddress(address: string): Promise<GeocodeOutcome> {
  if (env.geocodeSimulated) return { kind: "found", location: simulatedLocation(address) };
  const key = env.google.mapsApiKey;
  if (!key) return { kind: "disabled" };

  const params = new URLSearchParams({
    address: `${address}, Cali, Valle del Cauca`,
    components: "country:CO",
    bounds: `${AREA.south},${AREA.west}|${AREA.north},${AREA.east}`,
    region: "co",
    language: "es",
    key,
  });

  try {
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[geocode] error HTTP ${response.status}`);
      return { kind: "failed" };
    }
    const data = (await response.json()) as GoogleGeocodeResponse;
    const outcome = interpretGeocode(data);
    if (outcome.kind === "failed") console.error(`[geocode] ${data.status}: ${data.error_message ?? ""}`);
    return outcome;
  } catch (error) {
    console.error("[geocode] no se pudo consultar:", error instanceof Error ? error.message : error);
    return { kind: "failed" };
  }
}
