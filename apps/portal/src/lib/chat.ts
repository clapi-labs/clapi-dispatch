import { formatPhone, phoneDigits } from "@/lib/format";
import type { ConversationSummary } from "@/lib/types";

/** Al motorizado se le ve con su nombre de Flota, no con el de su WhatsApp. */
export function conversationName(c: ConversationSummary) {
  return c.courierName || c.displayName || formatPhone(c.phone);
}

/**
 * El enlace al chat de un teléfono, en Conversaciones. El número va en el
 * fragmento (#): el navegador no se lo manda al servidor, así que no queda en
 * sus registros.
 */
export function chatHref(phone: string) {
  return `/conversaciones#tel=${phoneDigits(phone)}`;
}

/** El teléfono que pide un enlace de `chatHref`, o `null` si la dirección no trae uno. */
export function phoneFromHash(hash: string) {
  return hash.match(/^#tel=(\d+)$/)?.[1] ?? null;
}

/** Por qué no salió un mensaje escrito desde el portal, en palabras del operador. */
export function sendErrorText(reason?: string) {
  return reason === "no_bot" || reason === "bad_secret"
    ? "El portal no está bien conectado con el bot (BOT_URL / INTERNAL_SECRET)."
    : "WhatsApp rechazó el mensaje. Si este número no escribe hace más de 24 h, Meta no deja escribirle primero.";
}
