export type LatLng = { lat: number; lng: number };

/** El área donde trabaja la agencia (Cali y Jamundí, con margen). Un punto
 *  fuera casi siempre es un error al copiar: coordenadas al revés, de otra
 *  ciudad o un número que no era. */
export const SERVICE_AREA = { south: 3.0, north: 3.8, west: -76.8, east: -76.2 };

export function inServiceArea({ lat, lng }: LatLng) {
  return lat >= SERVICE_AREA.south && lat <= SERVICE_AREA.north && lng >= SERVICE_AREA.west && lng <= SERVICE_AREA.east;
}

/**
 * Las coordenadas de lo que se copia de Google Maps:
 *
 * - Clic derecho sobre el local → la primera línea del menú: "3.37261, -76.53012".
 * - El enlace largo de la barra de direcciones: ".../@3.3726,-76.5301,17z" o
 *   "...!3d3.3726!4d-76.5301" (este es el punto exacto del local, no el centro
 *   del mapa, así que gana si vienen los dos).
 * - Un enlace con "?q=3.3726,-76.5301" o "ll=…".
 *
 * Los enlaces cortos (maps.app.goo.gl) no traen las coordenadas: devuelve null.
 */
export function parseCoordinates(text: string): LatLng | null {
  const input = text.trim();
  if (!input) return null;
  const num = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

  const place = input.match(new RegExp(String.raw`!3d${num}!4d${num}`));
  const at = input.match(new RegExp(String.raw`@${num},${num}`));
  const query = input.match(new RegExp(String.raw`[?&](?:q|ll|query|destination)=${num}(?:,|%2C)\s*${num}`, "i"));
  const plain = input.match(new RegExp(String.raw`^${num}\s*[,;\s]\s*${num}$`));

  const match = place ?? query ?? at ?? plain;
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** El enlace para revisar un punto en Google Maps. */
export function googleMapsLink({ lat, lng }: LatLng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
