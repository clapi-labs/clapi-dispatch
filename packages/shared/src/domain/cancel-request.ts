/**
 * El restaurante pide cancelar un pedido ya creado («me lo cancelas?»,
 * «cancélame el A-57», «el cliente canceló»). El bot no cancela solo: le pasa
 * el pedido a la central, que lo cancela o lo devuelve, y le confirma al
 * restaurante que ya le avisó.
 *
 * Esto es la red de seguridad en código, como `errand.ts`: el modelo marca el
 * resto (`cancelar` en el prompt de extracción). Ojo: en Colombia «cancelar»
 * también es pagar («el cliente cancela en efectivo», «cancela con billete de
 * 50»), y eso no es una cancelación.
 */

const norm = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

const PATTERNS: RegExp[] = [
  // «me lo cancelas», «nos la cancelan»
  /\b(?:me|nos)\s+(?:lo|la|los|las)\s+cancel(?:a|as|an|e|en|arias?|arian)\b/,
  // «cancélame», «cancélenme», «cancelarme», «cancélamelo»
  /\bcancel(?:a|e|en|ar)(?:me|nos)(?:lo|la|los|las)?\b/,
  // «cancélalo», «cancelarlo», «cancélenla»
  /\bcancel(?:a|e|en|ar|as)(?:lo|la|los|las)\b/,
  // «cancela el pedido», «cancelen ese domi», «anula el A-57», «cancelar el servicio»
  /\b(?:cancel(?:a|as|e|en|ar|amos)|anul(?:a|as|e|en|ar))\s+(?:(?:el|ese|este|mi|la|esa|esta)\s+)?(?:pedido|servicio|domi|domicilio|moto|orden|envio|[a-z]-?\s?\d{1,4}\b)/,
  // «el cliente canceló», «el cliente ya lo canceló», «quedó cancelado»
  /\bel cliente\s+(?:ya\s+)?(?:lo\s+|la\s+)?cancelo\b|\b(?:queda|quedo|esta|fue)\s+cancelad[oa]\b/,
];

/** «cancela en efectivo», «cancela con billete de 50», «ya canceló por Nequi»,
 *  «le cancela al domi»: pagar, no cancelar. */
const PAYING = /cancel\w*\s+(?:\S+\s+){0,3}?(?:efectivo|tarjeta|transferencia|nequi|daviplata|bancolombia|billete|datafono|\$|\d)|cancel\w*\s+(?:al|el)\s+(?:domi|domiciliario|valor|total)\b|cancel\w*\s+(?:cuando|contra)\b/;

/** Si el texto pide, sin duda, cancelar un pedido. */
export function looksLikeCancelRequest(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  const text = norm(raw);
  if (PAYING.test(text)) return false;
  return PATTERNS.some((p) => p.test(text));
}

const codesText = (codes: string[]) => (codes.length <= 1 ? codes.join("") : `${codes.slice(0, -1).join(", ")} y ${codes.at(-1)}`);

/** Con qué empieza el motivo de un chat que pidió cancelar: al cancelarlo desde
 *  el portal, el chat vuelve al bot (`cancelTrip`). */
export const CANCEL_REQUEST_REASON_PREFIX = "Pidió cancelar";

/** El motivo del chat que pasa a la central. */
export function cancelReason(codes: string[]): string {
  if (codes.length === 1) return `Pidió cancelar el pedido ${codes[0]}.`;
  return `Pidió cancelar un pedido sin decir cuál: tiene abiertos ${codesText(codes)}.`;
}

/** Lo que se le responde al restaurante: la central lo cancela. */
export function cancelReceivedText(codes: string[]): string {
  const which = codes.length === 1 ? `el ${codes[0]}` : "tu pedido";
  return `Recibido 🙏 Le paso a la central que quieres cancelar ${which}. Ya te confirmamos.`;
}

/**
 * «ya no gracias», «olvídalo», «mejor no», «cancélalo»: el restaurante
 * desiste de lo que se estaba armando o cotizando (todavía no hay viaje). Solo
 * en un mensaje corto y sin números: «ya no es para la 10, es para la 12» es
 * una corrección, no desistir.
 */
const LEAD = String.raw`^(?:(?:no+|nono|ah|ok|bueno|listo|vale|uy)\s+)*`;
const DROP = new RegExp(
  `${LEAD}(?:ya no|mejor no|no gracias|ya no gracias|olvidalo|olvidelo|olvida(?:lo)? eso|dejalo|dejelo|dejalo asi|dejemoslo asi|dejemos asi|no importa|no lo necesito|ya no lo necesito|ya no se necesita|ya no va|no va)\\b`,
);
/** «cancélalo», «cancela eso porfa»: solo o con palabras de relleno, nunca
 *  «cancela en efectivo» (pagar). */
const DROP_CANCEL = new RegExp(`${LEAD}(?:cancela(?:lo|la)?|cancelemos|anula(?:lo|la)?)(?:\\s+(?:eso|todo|porfa|por favor|gracias|mejor|la cotizacion|el pedido|ese pedido))*$`);

export function looksLikeDropDraft(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  const text = norm(raw)
    .replace(/[^a-z\s]/g, (c) => (/\d/.test(c) ? c : " "))
    .replace(/\s+/g, " ")
    .trim();
  if (/\d/.test(text) || text.split(" ").length > 7 || PAYING.test(text)) return false;
  return DROP.test(text) || DROP_CANCEL.test(text);
}

/** Lo que se le responde: no se pidió ninguna moto. */
export const DRAFT_DROPPED_TEXT = "Listo, no pido nada 👍 Cuando necesites un domi, aquí estoy.";
