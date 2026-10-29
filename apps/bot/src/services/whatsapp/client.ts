import { env } from "@/env";

/**
 * Único camino de salida hacia WhatsApp — igual que CLAPI (RN-05 de su
 * diseño): el portal no le habla a Meta, le pide al bot que envíe.
 *
 * Meta solo deja escribirle a alguien que nos escribió en las últimas 24 h.
 * Fuera de esa ventana el envío vuelve como `http_error` (código 131047) — no
 * se oculta: quien llama lo registra y el portal lo muestra.
 */

export type SendResult =
  | { ok: true }
  | { ok: false; reason: "bot_inactive" }
  | { ok: false; reason: "http_error"; status: number; body: unknown }
  | { ok: false; reason: "network_error"; error: string };

const MAX_BUTTON_TITLE = 20;

/** Modo simulado (`WHATSAPP_SIMULADO=true`): nada sale hacia Meta; cada
 *  envío se imprime en la terminal. Es el que usa `npm run bot:chat`. */
function simulate(payload: Record<string, unknown>): SendResult {
  if (payload.type === "text") {
    console.log(`\n🤖 → ${payload.to}\n${(payload.text as { body: string }).body}\n`);
  } else if (payload.type === "interactive") {
    const interactive = payload.interactive as { body: { text: string }; action: { buttons: { reply: { id: string; title: string } }[] } };
    const buttons = interactive.action.buttons.map((b) => `[${b.reply.title}] (${b.reply.id})`).join("  ");
    console.log(`\n🤖 → ${payload.to}\n${interactive.body.text}\n   ${buttons}\n`);
  }
  return { ok: true };
}

async function post(payload: Record<string, unknown>): Promise<SendResult> {
  if (env.whatsappSimulated) return simulate(payload);
  if (!env.botActive) return { ok: false, reason: "bot_inactive" };

  try {
    const response = await fetch(
      `https://graph.facebook.com/${env.whatsapp.apiVersion}/${env.whatsapp.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.whatsapp.accessToken}` },
        body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
      },
    );

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      console.error("[whatsapp] envío rechazado", response.status, JSON.stringify(body));
      return { ok: false, reason: "http_error", status: response.status, body };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "network_error", error: String(error) };
  }
}

export function sendText(phone: string, text: string) {
  return post({ to: phone, type: "text", text: { body: text } });
}

/** Botones de respuesta rápida: máximo 3, títulos de 20 caracteres (Meta). */
export function sendButtons(phone: string, text: string, buttons: { id: string; title: string }[]) {
  return post({
    to: phone,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, MAX_BUTTON_TITLE) } })),
      },
    },
  });
}

/**
 * Doble check azul + "escribiendo…" en el chat del remitente. Meta quita el
 * indicador al enviar la respuesta o a los 25 s. Si falla no importa: es
 * cosmético y la respuesta sale igual.
 */
export function markReadAndTyping(waMessageId: string) {
  return post({ status: "read", message_id: waMessageId, typing_indicator: { type: "text" } });
}
