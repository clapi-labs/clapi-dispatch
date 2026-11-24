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
