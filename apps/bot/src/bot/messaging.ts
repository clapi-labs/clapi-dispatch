import { recordMessage } from "@/db/queries/conversation";
import { sendButtons, sendText, type SendResult } from "@/services/whatsapp/client";

export type OutgoingOptions = {
  /** El wamid que se cita: el mensaje con que el restaurante abrió el pedido. */
  replyTo?: string | null;
  /** El viaje del que habla el mensaje, si ya existe. */
  tripId?: number | null;
  buttons?: { id: string; title: string }[];
};

/**
 * Único camino para que el bot escriba: envía (citando si se pide), y deja
 * el mensaje en el hilo del portal con su wamid y su viaje. Así, cuando el
 * restaurante responda citando este mensaje, se sabe de qué pedido habla.
 */
export async function say(conversationId: number | null, phone: string, text: string, options: OutgoingOptions = {}): Promise<SendResult> {
  const result = options.buttons?.length
    ? await sendButtons(phone, text, options.buttons, { replyTo: options.replyTo })
    : await sendText(phone, text, { replyTo: options.replyTo });

  if (conversationId) {
    await recordMessage(conversationId, "bot", result.ok ? text : `${text}\n\n⚠️ No se pudo enviar por WhatsApp (${result.reason}).`, {
      waMessageId: result.ok ? result.messageId : null,
      tripId: options.tripId ?? null,
    });
  }
  return result;
}
