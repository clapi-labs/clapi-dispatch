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

/** La razón que queda cuando alguien de la central toma el chat por su cuenta
 *  (botón "Intervenir"). El bot usa la misma en apps/bot/src/app/api/internal/send/route.ts. */
export const TAKEOVER_REASON = "Un operador tomó la conversación.";

/**
 * El chat pide ayuda: el bot lo escaló a una persona y lo último que se dijo
 * no es de la central. Mientras sea así va fijado arriba, en amarillo, y cuenta
 * en la burbuja de la navegación. Cuando el asesor responde deja de pedir
 * ayuda; con "Devolver al bot" se desfija. Un chat que la central tomó por su
 * cuenta ("Intervenir") no pide ayuda: ya hay alguien en él.
 * La misma regla está en SQL en `countNeedingHelp`.
 */
export function needsHelp(c: Pick<ConversationSummary, "botPaused" | "escalationReason" | "lastRole">) {
  return c.botPaused && c.escalationReason !== TAKEOVER_REASON && c.lastRole !== "agent";
}
