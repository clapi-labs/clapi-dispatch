/**
 * «¿Llegan a Jamundí?», «domi para Palmira»: el restaurante nombra solo un
 * municipio, sin dirección. Eso no se puede ubicar ni cotizar (el precio
 * depende de la dirección), así que no se le pregunta a la central: se le
 * responde si llegamos y se le pide la dirección. La agencia maneja Cali y
 * Jamundí; a otro municipio no se llega.
 *
 * Una dirección completa en otro municipio («Calle 10 # 5-20, Palmira») sí se
 * ubica, y la deciden las zonas de servicio como siempre.
 */

/** Donde sí se llega, según la dirección. */
const SERVED = ["Cali", "Jamundí"] as const;

/** Municipios que un restaurante de Cali podría nombrar: no se llega. */
const NOT_SERVED = [
  "Yumbo",
  "Palmira",
  "Candelaria",
  "Puerto Tejada",
  "Villa Rica",
  "Santander de Quilichao",
  "Dagua",
  "La Cumbre",
  "Vijes",
  "Florida",
  "Pradera",
  "El Cerrito",
  "Ginebra",
  "Guacarí",
  "Buga",
  "Tuluá",
  "Cartago",
  "Buenaventura",
  "Popayán",
  "Pasto",
  "Pereira",
  "Armenia",
  "Manizales",
  "Ibagué",
  "Bogotá",
  "Medellín",
  "Barranquilla",
  "Cartagena",
  "Bucaramanga",
] as const;

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const BY_NAME = new Map<string, { name: string; served: boolean }>([
  ...SERVED.map((name) => [fold(name), { name, served: true }] as const),
  ...NOT_SERVED.map((name) => [fold(name), { name, served: false }] as const),
  // Como se dice en la calle.
  ["santiago de cali", { name: "Cali", served: true }],
  ["quilichao", { name: "Santander de Quilichao", served: false }],
]);

/** Lo que puede rodear al municipio sin volverlo una dirección. */
const PREFIX = /^(?:hasta|para|a|al|en|el|la|municipio de|el municipio de|ciudad de)\s+/;
const SUFFIX = /\s+(?:valle|del valle|valle del cauca|cauca|centro|colombia)$/;

/**
 * Si la dirección es solo un municipio («Jamundí», «para Palmira», «Jamundí,
 * Valle»), cuál y si se llega; `null` si es una dirección o un lugar dentro
 * de la ciudad.
 */
export function placeOnly(address: string | null | undefined): { name: string; served: boolean } | null {
  if (!address) return null;
  let s = fold(address);
  if (!s || /\d/.test(s)) return null;
  for (let i = 0; i < 3; i++) s = s.replace(PREFIX, "").replace(SUFFIX, "").trim();
  return BY_NAME.get(s) ?? null;
}

/** «¡Sí! Llegamos a Jamundí…»: se llega, pero el precio sale de la dirección. */
export function servedPlaceText(name: string): string {
  return `¡Sí! Llegamos a ${name} 🙌 El precio depende de la dirección: ¿me la envías? También me sirve la ubicación de WhatsApp.`;
}

/** «Qué pena, a Palmira no llegamos…». */
export function notServedPlaceText(name: string): string {
  return `Qué pena 🙏 A ${name} no llegamos: manejamos Cali y Jamundí.`;
}
