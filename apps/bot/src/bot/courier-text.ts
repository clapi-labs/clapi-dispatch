import type { DeliveryPlace } from "@dispatch/shared";

/**
 * Lo que escribe el motorizado en vez de tocar un botón. Sin base ni WhatsApp,
 * para probarlo solo; lo usa `courier.ts`. Los pendientes de regreso
 * («llevo datáfono», «quedé debiendo en X») están en `domain/return-debts.ts`.
 */

/** «Ok», «voy», «ya lo vi», «recibido», 👍: un acuse corto, sin nada más. */
const ACK = /^(ok[aiy]?|okey|listo|visto|ya lo vi|lo vi|ya vi|voy|ya voy|vamos|va|dale|de una|recibido|enterado|copiado|en camino|voy para all[aá]|s[ií])[\s!.,👍✅🛵🙏]*$|^[\s👍✅🛵🙏]+$/iu;

export function isAck(text: string) {
  return ACK.test(text.trim());
}

const DISCONNECT = /^(?:desactivad[oa]|desactivar(?:me)?|me\s+desactivo)$/i;

/**
 * «Desactivado», sin importar mayúsculas, tildes ni signos («Desactivado.»,
 * «DESACTIVADO 👍»). Solo cuenta si el mensaje entero es la palabra o una
 * variante directa: una frase normal que la contenga sigue su camino.
 */
export function isDisconnect(raw: string): boolean {
  const clean = raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ");
  return DISCONNECT.test(clean);
}

const END = "[\\s!.,👍✅🛵🙏]*$";
const ALREADY = "^(?:ya\\s+)?(?:lo\\s+|el pedido\\s+)?";
/** «… y vuelvo»: de cuando la entrega decidía si volvía. Se acepta y se ignora:
 *  si tiene que volver, eso es un pendiente que declara al recoger. */
const AND_BACK = "(?:,?\\s*(?:y\\s+)?(?:vuelvo|regreso|me devuelvo|voy de vuelta)(?:\\s+al\\s+(?:restaurante|local))?)?";

const PICKED = new RegExp(`${ALREADY}recog[ií](?:\\s+el pedido)?${END}|^(?:ya\\s+)?tengo el pedido${END}|^pedido recogido${END}`, "iu");
const AT_GATE = new RegExp(`${ALREADY}(?:(?:dej[eé]|entregu[eé]|qued[oó]|entregad[oa])(?:\\s+el pedido)?\\s+)?en\\s+(?:la\\s+)?porter[ií]a${AND_BACK}${END}`, "iu");
const DELIVERED = new RegExp(`${ALREADY}(?:entregu[eé]|entregad[oa])(?:\\s+el pedido)?${AND_BACK}${END}`, "iu");

const NO_ANSWER = new RegExp(`^(?:el\\s+)?cliente no (?:contesta|responde|sale|baja|abre)${END}`, "iu");
const RETURNED = new RegExp(`^(?:ya\\s+)?(?:lo\\s+)?devolv[ií](?:\\s+el pedido)?${END}`, "iu");

export type CourierText = { kind: "picked" } | { kind: "delivered"; place: DeliveryPlace } | { kind: "no_answer" } | { kind: "returned" };

/**
 * Lo que escribe en vez de tocar el botón. Solo frases cortas y claras, sin
 * pasar por el modelo: «no lo entregué» o «lo dejé en portería pero…» no
 * coinciden y siguen a la clasificación, donde pueden ser una novedad.
 */
export function parseCourierText(raw: string): CourierText | null {
  const text = raw.trim();
  if (PICKED.test(text)) return { kind: "picked" };
  if (NO_ANSWER.test(text)) return { kind: "no_answer" };
  if (RETURNED.test(text)) return { kind: "returned" };
  if (AT_GATE.test(text)) return { kind: "delivered", place: "gate" };
  if (DELIVERED.test(text)) return { kind: "delivered", place: "customer" };
  return null;
}
