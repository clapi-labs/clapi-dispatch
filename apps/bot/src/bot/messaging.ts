import { AsyncLocalStorage } from "node:async_hooks";

import { simulatorEnabled } from "@dispatch/shared/db";

import { withGreeting } from "@/bot/greeting";
import { recordMessage } from "@/db/queries/conversation";
import { sendButtons, sendList, sendText, type ListOption, type SendResult } from "@/services/whatsapp/client";

export type OutgoingOptions = {
  /** El wamid que se cita: el mensaje con que el restaurante abrió el pedido. */
  replyTo?: string | null;
  /** El viaje del que habla el mensaje, si ya existe. */
  tripId?: number | null;
  buttons?: { id: string; title: string }[];
  list?: ListOption;
};

/** WhatsApp no acepta más que esto en el texto de un mensaje con botones o lista. */
const INTERACTIVE_BODY_MAX = 1024;

/**
 * El saludo del día pendiente en este turno (bot/greeting.ts): lo lleva el
 * primer mensaje que el bot le envíe a esa conversación, sea cual sea (la
 * cotización, lo que falta, el estado, el aviso de la central). Vive solo
 * mientras se atiende el turno, así que no hace falta pasarlo por cada función.
 */
const pendingGreeting = new AsyncLocalStorage<{ conversationId: number; greeting: string | null }>();

/** Atiende un turno con el saludo del día pendiente (o ninguno). */
export function inGreetingTurn<T>(conversationId: number, greeting: string | null, fn: () => Promise<T>): Promise<T> {
  return pendingGreeting.run({ conversationId, greeting }, fn);
}

/** ¿El próximo mensaje a esta conversación va a llevar el saludo del día? */
export function greetingPending(conversationId: number): boolean {
  const turn = pendingGreeting.getStore();
  return !!turn?.greeting && turn.conversationId === conversationId;
}

/**
 * Textos que solo existen en staging (el simulador y sus números de prueba).
 * Con el simulador apagado no le pueden llegar a nadie (#121).
 */
const TEST_ONLY_TEXT = /🧪|simulad[oa]r?|n[uú]meros? de prueba|staging/i;

export function leaksTestText(text: string): boolean {
  return TEST_ONLY_TEXT.test(text);
}

/**
 * Único camino para que el bot escriba: envía (citando si se pide), y deja
 * el mensaje en el hilo del portal con su wamid y su viaje. Así, cuando el
 * restaurante responda citando este mensaje, se sabe de qué pedido habla.
 */
export async function say(conversationId: number | null, phone: string, text: string, options: OutgoingOptions = {}): Promise<SendResult> {
  // El saludo del día va encima del primer mensaje del turno. Si con él no cabe
  // en un mensaje con botones, se queda para el siguiente.
  const turn = pendingGreeting.getStore();
  if (turn?.greeting && turn.conversationId === conversationId) {
    const greeted = withGreeting(turn.greeting, text);
    if (!(options.buttons?.length || options.list) || greeted.length <= INTERACTIVE_BODY_MAX) {
      text = greeted;
      turn.greeting = null;
    }
  }

  // Red de seguridad: con el simulador apagado, un texto de pruebas no sale.
  // Queda en el hilo del portal y en los registros, para corregirlo.
  if (!simulatorEnabled() && leaksTestText(text)) {
    console.error(`[produccion] no se envió un mensaje con texto de pruebas: ${text.slice(0, 80)}`);
    if (conversationId) await recordMessage(conversationId, "bot", `${text}\n\n⚠️ No se envió: es un texto de pruebas y esto es producción.`);
    return { ok: false, reason: "network_error", error: "texto de pruebas bloqueado en producción" };
  }

  const result = options.list
    ? await sendList(phone, text, options.list, { replyTo: options.replyTo })
    : options.buttons?.length
      ? await sendButtons(phone, text, options.buttons, { replyTo: options.replyTo })
      : await sendText(phone, text, { replyTo: options.replyTo });

  if (conversationId) {
    await recordMessage(conversationId, "bot", result.ok ? text : `${text}\n\n⚠️ No se pudo enviar por WhatsApp (${result.reason}).`, {
      waMessageId: result.ok ? result.messageId : null,
      tripId: options.tripId ?? null,
      replyTo: options.replyTo ?? null,
    });
  }
  return result;
}
