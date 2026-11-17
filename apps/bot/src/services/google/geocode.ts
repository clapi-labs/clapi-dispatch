import { haversineKm } from "@dispatch/shared";

import { env } from "../../env";

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
 *  barrio: para medir quién llega primero, eso no sirve. La excepción es el
 *  cruce de dos calles («Calle 42 con Carrera 85C»): Google lo da como
 *  GEOMETRIC_CENTER, pero es la esquina, un punto exacto. */
const PRECISE = new Set(["ROOFTOP", "RANGE_INTERPOLATED"]);
const precise = (r: GoogleGeocodeResult) => PRECISE.has(r.geometry.location_type) || !!r.types?.includes("intersection");

/** Un resultado que es una dirección, un edificio, un lugar o un cruce; no una calle ni un barrio. */
const PLACE_TYPES = ["street_address", "premise", "subpremise", "establishment", "point_of_interest", "intersection"];
const pinpoints = (r: GoogleGeocodeResult) => !r.types || r.types.some((t) => PLACE_TYPES.includes(t));

/** Dos resultados de la misma dirección a más de esto: hay dos lugares con esa
 *  placa (pasó con «Cl 52 # 3-29», en Salomia y a 4 km). No se elige: decide la central. */
const AMBIGUOUS_M = 500;

type GoogleGeocodeResult = {
  formatted_address?: string;
  partial_match?: boolean;
  types?: string[];
  geometry: { location: LatLng; location_type: string };
  address_components?: { long_name: string; short_name?: string; types: string[] }[];
};

export type GoogleGeocodeResponse = {
  status: string;
  error_message?: string;
  results?: GoogleGeocodeResult[];
};

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;

/** Quita tildes y pasa a minúsculas para comparar nombres de municipios y vías. */
function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Nombres de vías intermunicipales («Vía Cali - Jamundí», «Autopista Cali Yumbo»):
 *  mencionan otro municipio pero son una avenida dentro de Cali, no el municipio de destino. */
const ROAD_TO_MUNICIPALITY_RE = new RegExp(
  String.raw`${B}(?:v[ií]a|autopista|carretera|salida|camino|retorno|glorieta)\s+(?:antigua\s+|nueva\s+)?(?:(?:cali|jamund[ií]|yumbo|palmira|candelaria|dapa)\s*[-–/a]?\s*)+(?:jamund[ií]|yumbo|palmira|candelaria|dapa|cali)?${E}`,
  "giu",
);

type MunicipalitySpec = {
  key: string;
  label: string;
  pattern: RegExp;
  /** Tope geográfico opcional: Jamundí queda al sur del río Jamundí / límite con Cali (lat <= 3.32);
   *  Ciudad Pacífica y Bochalema en Cali están en lat >= 3.34. */
  bounds?: { maxLat?: number; minLat?: number };
};

const OTHER_MUNICIPALITIES: MunicipalitySpec[] = [
  {
    key: "jamundi",
    label: "Jamundí",
    pattern: new RegExp(String.raw`${B}(?:jamundi|alfaguara|ciudad\s+country|parques\s+de\s+castilla|potrerito|sachamate|portal\s+de\s+jamundi)${E}`, "iu"),
    bounds: { maxLat: 3.32 },
  },
  {
    key: "yumbo",
    label: "Yumbo",
    pattern: new RegExp(String.raw`${B}(?:yumbo|acopi|dapa|arroyohondo|mulalo|mengabravo)${E}`, "iu"),
  },
  {
    key: "candelaria",
    label: "Candelaria",
    pattern: new RegExp(String.raw`${B}(?:candelaria|juanchito|poblado\s+campestre|villagorgona|buchitolo|el\s+carmelo)${E}`, "iu"),
  },
  {
    key: "palmira",
    label: "Palmira",
    pattern: new RegExp(String.raw`${B}(?:palmira|rozo|la\s+dolores|palmaseca|amaime)${E}`, "iu"),
  },
  {
    key: "puerto tejada",
    label: "Puerto Tejada",
    pattern: new RegExp(String.raw`${B}puerto\s+tejada${E}`, "iu"),
  },
  {
    key: "dagua",
    label: "Dagua",
    pattern: new RegExp(String.raw`${B}dagua${E}`, "iu"),
  },
  {
    key: "la cumbre",
    label: "La Cumbre",
    pattern: new RegExp(String.raw`${B}la\s+cumbre${E}`, "iu"),
  },
  {
    key: "vijes",
    label: "Vijes",
    pattern: new RegExp(String.raw`${B}vijes${E}`, "iu"),
  },
];

/**
 * Si la dirección nombra otro municipio del área metropolitana (Jamundí, Yumbo,
 * Candelaria, Palmira…), devuelve cuál es para no forzar «Cali» en la consulta
 * ni aceptar un punto que Google ubique por error dentro de Cali.
 */
export function requestedMunicipality(address: string): MunicipalitySpec | null {
  const withoutRoads = plain(address).replace(ROAD_TO_MUNICIPALITY_RE, " ");
  for (const m of OTHER_MUNICIPALITIES) {
    if (m.pattern.test(withoutRoads)) return m;
  }
  return null;
}

/**
 * Arma el texto que se manda a Google Geocoding:
 * - Separa «30#1-15» como «30 # 1-15» para que Google no ignore el número.
 * - Si la dirección es de otro municipio («Calle 30#1-15 jamundi»), NO le pega
 *   «, Cali» al final (eso hacía que Google buscara la calle homónima dentro de
 *   Cali y la metiera en Ciudad Pacífica / Villa Fátima).
 */
export function buildGeocodeQuery(address: string): string {
  let clean = address
    .trim()
    .replace(/(\d|[a-zA-Z])\s*#\s*(\d)/g, "$1 # $2")
    .replace(/\s+/g, " ");
  const other = requestedMunicipality(clean);
  if (other) {
    const trailingCity = new RegExp(String.raw`(?:,\s*|\s+)(${other.key})$`, "iu");
    if (trailingCity.test(plain(clean))) {
      clean = clean.replace(new RegExp(String.raw`(?:,\s*|\s+)[^\s,]+$`, "u"), `, ${other.label}`);
    } else if (!new RegExp(String.raw`${B}${other.key}${E}`, "iu").test(plain(clean))) {
      clean = `${clean}, ${other.label}`;
    }
    return /valle\s+del\s+cauca/iu.test(clean) ? clean : `${clean}, Valle del Cauca`;
  }
  const endsWithCali = /(?:,\s*|\s+)cali(?:\s*,\s*valle\s+del\s+cauca)?$/iu.test(clean);
  return endsWithCali ? (/valle\s+del\s+cauca/iu.test(clean) ? clean : `${clean}, Valle del Cauca`) : `${clean}, Cali, Valle del Cauca`;
}

function insideArea({ lat, lng }: LatLng) {
  return lat >= AREA.south && lat <= AREA.north && lng >= AREA.west && lng <= AREA.east;
}

/** El municipio que reporta Google en `address_components` (`locality` o `administrative_area_level_2`). */
function resultMunicipalities(r: GoogleGeocodeResult): string[] {
  const names: string[] = [];
  for (const c of r.address_components ?? []) {
    if (c.types.includes("locality") || c.types.includes("administrative_area_level_2")) {
      names.push(plain(c.long_name));
    }
  }
  if (r.formatted_address) names.push(plain(r.formatted_address));
  return names;
}

function matchesMunicipality(r: GoogleGeocodeResult, expected: MunicipalitySpec | null): boolean {
  const reported = resultMunicipalities(r);
  if (expected) {
    if (expected.bounds?.maxLat !== undefined && r.geometry.location.lat > expected.bounds.maxLat) return false;
    if (expected.bounds?.minLat !== undefined && r.geometry.location.lat < expected.bounds.minLat) return false;
    // Si Google devolvió explícitamente Cali cuando pedían otro municipio, se descarta.
    const locality = r.address_components?.find((c) => c.types.includes("locality") || c.types.includes("administrative_area_level_2"));
    if (locality && /\bcali\b/.test(plain(locality.long_name))) return false;
    if (reported.length > 0) {
      return reported.some((name) => name.includes(expected.key));
    }
    return true;
  }
  // Si no pidió otro municipio (es Cali), descarta resultados que caigan en Jamundí, Yumbo, Palmira o Candelaria.
  const locality = r.address_components?.find((c) => c.types.includes("locality") || c.types.includes("administrative_area_level_2"));
  if (locality) {
    const loc = plain(locality.long_name);
    if (OTHER_MUNICIPALITIES.some((m) => new RegExp(String.raw`${B}${m.key}${E}`, "u").test(loc))) return false;
  }
  return true;
}

const WRITTEN_STREET_RE = new RegExp(
  String.raw`${B}(?:calle|cll?|carrera|cra?|kr|diagonal|dg|transversal|tv|tr|avenida|av)\.?\s*(\d{1,3})\s*[a-z]?(?:\s+(?:bis|norte|nt|sur|oeste|oe|este))?\s*(?:#|no\.?|n[uú]mero|\bcon\b)\s*(\d{1,3})`,
  "iu",
);

/**
 * Si la dirección escrita tiene calle y placa («Calle 30 # 1-15»), verifica que
 * el resultado de Google no sea otra vía inventada en el barrio (como devolver
 * «Calle 40» en Ciudad Pacífica cuando «Calle 30 # 1-15» no existe allá).
 */
function matchesWrittenStreet(r: GoogleGeocodeResult, address: string): boolean {
  const match = WRITTEN_STREET_RE.exec(plain(address));
  if (!match) return true;
  const [, mainNum, crossNum] = match;
  const components = r.address_components ?? [];
  const routeComp = components.find((c) => c.types.includes("route"));
  const streetNumComp = components.find((c) => c.types.includes("street_number"));
  if (!routeComp && !streetNumComp && !r.formatted_address) return true;

  const haystack = plain([routeComp?.long_name, routeComp?.short_name, streetNumComp?.long_name, r.formatted_address].filter(Boolean).join(" "));
  const hasMain = new RegExp(String.raw`(?<![0-9])${mainNum}(?![0-9])`, "u").test(haystack);
  const hasCross =
    streetNumComp !== undefined && new RegExp(String.raw`^${crossNum}(?![0-9])`, "u").test(plain(streetNumComp.long_name)) ||
    new RegExp(String.raw`(?:#|-\s*|\s)${crossNum}\s*-\s*\d`, "u").test(haystack);

  // Si Google marcó partial_match y ni siquiera coincide la vía principal, es un salto a otra calle.
  if (r.partial_match && !hasMain) return false;
  // La vía del resultado tiene número y es otra («Cra 94A #42-64» para «Carrera 97 # 42-10»):
  // coincidir en la placa no basta. Una vía con nombre propio (Av. Pasoancho) sí puede ser la escrita.
  const routeNum = routeComp ? /(?<![0-9])(\d{1,3})(?![0-9])/u.exec(plain(routeComp.long_name))?.[1] : undefined;
  if (routeNum && routeNum !== mainNum) return false;
  return hasMain || hasCross;
}

/** Los números de la vía y la placa del resultado («Carrera 95A», «42-141» → 95, 42, 141). */
function resultNumbers(r: GoogleGeocodeResult): string[] {
  const components = r.address_components ?? [];
  const route = components.find((c) => c.types.includes("route"))?.long_name;
  const plate = components.find((c) => c.types.includes("street_number"))?.long_name;
  if (!route || !plate) return [];
  return plain(`${route} ${plate}`).match(/\d+/gu) ?? [];
}

/** El texto trae, en orden, la vía y la placa del resultado aunque sin «#» («kra 95a 42 141»). */
function writesResultNumbers(r: GoogleGeocodeResult, address: string): boolean {
  const wanted = resultNumbers(r);
  if (wanted.length < 3) return false;
  const written = plain(address).match(/\d+/gu) ?? [];
  let i = 0;
  for (const n of written) if (n === wanted[i]) i++;
  return i === wanted.length;
}

/** Sin vía y placa escritas («Unicentro», «Valle del Lili»), un resultado
 *  parcial es Google adivinando: «Valle del Lili» daba la clínica, «Bochalema»
 *  un local del barrio y «Univalle sede Meléndez» la sede de San Fernando.
 *  Con eso, también pasan a la central lugares que Google sí acertaba
 *  (Unicentro, la Javeriana): se prefiere eso a un punto inventado. */
function trustsPlace(r: GoogleGeocodeResult, address: string): boolean {
  return !r.partial_match || WRITTEN_STREET_RE.test(plain(address)) || writesResultNumbers(r, address);
}

/** Pura: decide con la respuesta de Google, sin red. */
export function interpretGeocode(data: GoogleGeocodeResponse, address = ""): GeocodeOutcome {
  if (data.status === "ZERO_RESULTS") return { kind: "not_found" };
  if (data.status !== "OK") return { kind: "failed" };
  const expected = requestedMunicipality(address);
  const plausible = (data.results ?? []).filter(
    (r) => insideArea(r.geometry.location) && matchesMunicipality(r, expected) && matchesWrittenStreet(r, address),
  );
  const best = plausible.find((r) => precise(r) && trustsPlace(r, address));
  if (!best) return { kind: "not_found" };
  // Otra dirección o lugar que también sirve, lejos de este: no se sabe cuál es.
  // El centro de una calle o de un barrio no cuenta como otro lugar.
  const otherPlace = plausible.some((r) => pinpoints(r) && haversineKm(r.geometry.location, best.geometry.location) * 1000 > AMBIGUOUS_M);
  if (otherPlace) return { kind: "not_found" };
  const sub = best.address_components?.find((c) => c.types.includes("neighborhood") || c.types.includes("sublocality"))?.long_name ?? null;
  const neighborhood = expected ? (sub ? `${sub}, ${expected.label}` : expected.label) : sub;
  return { kind: "found", location: best.geometry.location, neighborhood };
}

/**
 * Ubicación de mentira para pruebas y demostraciones sin Google
 * (`GEOCODE_SIMULADO=true`; el chat de prueba la usa por defecto). La misma
 * dirección cae siempre en el mismo punto, dentro de Cali (o en Jamundí si la
 * dirección pide Jamundí). Nunca en producción: el precio saldría inventado.
 */
function simulatedLocation(address: string): LatLng {
  let hash = 0;
  for (const ch of address.toLowerCase().replace(/\s+/g, " ").trim()) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const a = ((hash >>> 0) % 1000) / 1000;
  const b = (((hash >>> 10) >>> 0) % 1000) / 1000;
  const other = requestedMunicipality(address);
  if (other?.key === "jamundi") return { lat: 3.26 + (a - 0.5) * 0.02, lng: -76.54 + (b - 0.5) * 0.02 };
  if (other?.key === "yumbo") return { lat: 3.58 + (a - 0.5) * 0.02, lng: -76.49 + (b - 0.5) * 0.02 };
  return { lat: 3.37 + (a - 0.5) * 0.08, lng: -76.53 + (b - 0.5) * 0.06 };
}

/** Un solo intento: si Google no responde, quien llama decide (hoy: pasa el
 *  pedido a la central, no se cobra sin ubicación). */
export async function geocodeAddress(address: string): Promise<GeocodeOutcome> {
  if (env.geocodeSimulated) return { kind: "found", location: simulatedLocation(address) };
  const response = await requestGeocode(address);
  if (response.kind !== "response") return response;
  const outcome = interpretGeocode(response.data, address);
  if (outcome.kind === "failed") console.error(`[geocode] ${response.data.status}: ${response.data.error_message ?? ""}`);
  return outcome;
}

/**
 * La consulta a Google, con la respuesta tal cual: `geocodeAddress` decide
 * con ella, y la medición de precisión (`address-bench.ts`) además la muestra.
 */
export async function requestGeocode(
  address: string,
): Promise<{ kind: "response"; data: GoogleGeocodeResponse } | { kind: "failed" } | { kind: "disabled" }> {
  const key = env.google.mapsApiKey;
  if (!key) return { kind: "disabled" };

  const params = new URLSearchParams({
    address: buildGeocodeQuery(address),
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
    return { kind: "response", data: (await response.json()) as GoogleGeocodeResponse };
  } catch (error) {
    console.error("[geocode] no se pudo consultar:", error instanceof Error ? error.message : error);
    return { kind: "failed" };
  }
}
