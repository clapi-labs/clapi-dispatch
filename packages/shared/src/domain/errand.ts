/**
 * Encargos: el restaurante no pide llevar su comida a un cliente, sino que le
 * compren o le traigan algo («me compran un queso tajado en la salsamentaria»,
 * «de ir al Ara a comprar 3 paquetes de tortillas», «me traes 30 envases»).
 * No se cotizan ni se asignan solos: van a la central.
 *
 * Esto es la red de seguridad en código: frases inequívocas que no dependen del
 * modelo. El modelo marca el resto (`encargo` en el prompt de extracción) y
 * basta con que uno de los dos lo vea, porque un encargo tomado como domicilio
 * crea un viaje al revés. Por eso aquí solo van patrones que un domicilio
 * normal no usa: «el cliente compró», «quiero comprar 2 combos» (reenviado del
 * cliente) o «me traen la plata» (un reclamo) no son encargos.
 */

const norm = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

/** Lo que el restaurante pide que le traigan y no es un encargo: su plata, su
 *  datáfono, una suma («los 50 mil»), papeles del pedido o el pedido mismo de
 *  vuelta. */
const NOT_ERRAND_OBJECT = "(?:(?:los\\s+)?\\d[\\d.]*\\s*(?:mil|lucas|k)|la plata|el dinero|el efectivo|la platica|el datafono|los datafonos|la factura|las facturas|el recibo|el comprobante|el cambio|la devuelta|el vuelto|el pedido|los pedidos|el domicilio|la comida)";

const PATTERNS: RegExp[] = [
  // «me compran», «nos compras», «me consiguen», «me compre»
  /\b(?:me|nos)\s+(?:compra[ns]?|compre[ns]?|consigue[ns]?|consiga[ns]?)\b/,
  // «cómprame», «cómprenme», «comprarme», «comprarnos», «conseguirme»
  /\bcompr(?:ame|enme|anos|ennos|arme|arnos)\b|\bconseguir(?:me|nos)\b/,
  // «ir al Ara a comprar», «vayan al D1 a comprar», «pase por el supermercado a comprar»
  /\b(?:ir|vaya[ns]?|vas|pase[ns]?|pasar)\s+(?:a|al|a la|por|donde)\b.{0,40}?\ba\s+comprar\b/,
  // «es para comprar», «de ir a comprar», «favor de comprar», «que compren»
  /\b(?:para|de)\s+(?:ir\s+a\s+)?comprar\b|\bfavor(?:\s+de)?[:,]?\s+comprar\b|\bque\s+(?:me\s+|nos\s+)?compre[ns]?\b/,
  // «me lo traes», «me la compran»
  /\b(?:me|nos)\s+(?:lo|la|los|las)\s+(?:trae[ns]?|traiga[ns]?|compra[ns]?|compre[ns]?|consigue[ns]?)\b/,
  // «traérmelo», «tráiganme», «tráeme», «traerlos acá»
  /\btraer(?:me|nos)(?:lo|la|los|las)?\b|\btraiga(?:me|nos)(?:lo|la|los|las)?\b|\btrae(?:me|nos)(?:lo|la|los|las)?\b|\btraer(?:lo|la|los|las)\s+(?:aca|aqui|al local|al restaurante)\b/,
  // «me pueden traer», «nos podrían conseguir»
  /\b(?:me|nos)\s+(?:pueden|puede|podrian|podria|podes)\s+(?:traer|comprar|conseguir)\b/,
  // «y de camino le compras una gaseosa al cliente»: un domicilio con un encargo adentro
  /\b(?:le|les)\s+(?:compras|compran|compre[ns]?|consigue[ns]|consigas)\b/,
  // «¿me pueden hacer una vuelta?», «un mandado»
  /\bhacer(?:me|nos)?\s+(?:una|un)\s+(?:vuelta|vueltica|mandado|mandadito|diligencia|encargo)\b|\bun\s+(?:mandado|mandadito)\b/,
];

/** «me traes 30 envases», «me traigan 4 coca colas»: traer algo que no sea la
 *  plata, el datáfono o papeles del pedido. */
const BRING = new RegExp(`\\b(?:me|nos)\\s+(?:trae[ns]?|traiga[ns]?|traeria[ns]?)\\b(?!\\s+${NOT_ERRAND_OBJECT}\\b)`);

/** Si el texto pide, sin duda, que le compren o le traigan algo. */
export function looksLikeErrand(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  const text = norm(raw);
  return BRING.test(text) || PATTERNS.some((p) => p.test(text));
}

/** Con qué empieza el motivo de un chat que pasó a la central por un encargo:
 *  así lo reconocen el portal y la alerta al celular. */
export const ERRAND_REASON_PREFIX = "Encargo:";

/** Hasta dónde se guarda lo que pidió: cabe en el mensaje del domiciliario
 *  (1.024 caracteres con botón) junto con el resto de su ficha. */
const ERRAND_REQUEST_MAX = 600;

/** Cuando no hay texto (solo una foto, por ejemplo). */
const ERRAND_NO_TEXT = "pidió comprar o traer algo (ver el chat)";

/** El motivo del escalado, con lo que pidió el restaurante tal cual. */
export function errandReason(text: string): string {
  const said = text.replace(/\s+/g, " ").trim();
  const clipped = said.length > ERRAND_REQUEST_MAX ? `${said.slice(0, ERRAND_REQUEST_MAX - 1)}…` : said;
  return clipped ? `${ERRAND_REASON_PREFIX} «${clipped}»` : `${ERRAND_REASON_PREFIX} ${ERRAND_NO_TEXT}`;
}

export function isErrandReason(reason: string | null | undefined): boolean {
  return !!reason?.startsWith(ERRAND_REASON_PREFIX);
}

/** Lo que se le responde al restaurante: la central coordina el encargo. */
export const ERRAND_RECEIVED_MESSAGE = "Recibido 🛍️ Le paso tu encargo a la central para coordinarlo. Ya te confirmamos 🙏";

/** Lo que pidió el restaurante, sacado del motivo del escalado: es lo que
 *  guarda el encargo y lo que lee el domiciliario. `null` si el motivo no es de
 *  un encargo o no trae texto. */
export function errandRequest(reason: string | null | undefined): string | null {
  if (!isErrandReason(reason)) return null;
  const rest = reason!.slice(ERRAND_REASON_PREFIX.length).trim();
  const quoted = rest.match(/^«([\s\S]*)»$/);
  if (quoted) return quoted[1].trim() || null;
  return rest && rest !== ERRAND_NO_TEXT ? rest : null;
}

/** Al crear el encargo desde el panel: el chat vuelve al bot y se le confirma. */
export function errandCreatedText(code: string): string {
  return `Listo ✅ Tu encargo ${code} quedó registrado. Te aviso cuando salga el domiciliario 🛍️`;
}

/** Al asignarlo: quién va. Sin su número, como en los domicilios. */
export function errandAssignedText(code: string, courierName: string | null | undefined): string {
  const first = courierName?.trim().split(/\s+/)[0];
  return first ? `🛵 Va ${first} con tu encargo ${code}.` : `🛵 Va un domiciliario con tu encargo ${code}.`;
}

/** Al entregarlo en el restaurante. */
export function errandDeliveredText(code: string, at: string): string {
  return `🛍️ Encargo ${code} entregado a las ${at} ✅`;
}
