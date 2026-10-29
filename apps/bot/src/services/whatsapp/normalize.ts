import type { IncomingMessage, WaMessage, WaWebhookPayload } from "./types";

/**
 * Convierte una entrega del webhook en `IncomingMessage[]`. Pura, igual que
 * en CLAPI: descarta `statuses` (acuses de mensajes nuestros) — procesarlos
 * haría que el bot le contestara a su propio acuse.
 *
 * A diferencia de CLAPI (que distingue texto/audio/imagen/botón porque el
 * cliente interactúa con menús y comprobantes), este bot solo necesita
 * texto: un restaurante pidiendo una moto escribe, no manda botones.
 */
export function extractIncomingMessages(payload: WaWebhookPayload): IncomingMessage[] {
  const out: IncomingMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const { value } = change;
      if (value.statuses?.length) continue;

      const profileByPhone = new Map<string, string | null>();
      for (const contact of value.contacts ?? []) {
        profileByPhone.set(contact.wa_id, contact.profile?.name ?? null);
      }

      for (const message of value.messages ?? []) {
        const normalized = normalizeOne(message, profileByPhone.get(message.from) ?? null);
        if (normalized) out.push(normalized);
      }
    }
  }

  return out;
}

function normalizeOne(message: WaMessage, profileName: string | null): IncomingMessage | null {
  if (typeof message.from !== "string" || message.from.length === 0) return null;

  const base = {
    waMessageId: message.id,
    phone: message.from,
    profileName,
    timestamp: new Date(Number(message.timestamp) * 1000),
    replyTo: message.context?.id ?? null,
  };

  if ("text" in message) {
    return { ...base, kind: "text", text: message.text.body };
  }

  if ("location" in message) {
    const { latitude, longitude, name, address } = message.location;
    const label = [name, address].filter(Boolean).join(", ") || null;
    return { ...base, kind: "location", lat: latitude, lng: longitude, label };
  }

  if ("interactive" in message) {
    const reply = message.interactive.button_reply ?? message.interactive.list_reply;
    if (!reply) return null;
    return { ...base, kind: "button", buttonId: reply.id, title: reply.title };
  }

  return { ...base, kind: "unsupported", type: message.type };
}
