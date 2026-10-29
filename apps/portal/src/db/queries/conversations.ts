import { asc, desc, eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { normalizeDraft } from "@dispatch/shared";

import type { DraftFields } from "@/lib/types";

/** La misma regla que `findCourier` en el bot (apps/bot/src/bot/intake.ts): un
 *  motorizado guardado como "3001234567" y el wa_id "573001234567" de
 *  WhatsApp son la misma persona. */
function last10(phone: string) {
  return phone.replace(/\D/g, "").slice(-10);
}

/** La bandeja: cada conversación con su último mensaje. Los que esperan a una
 *  persona (bot pausado) van arriba. Un solo SELECT de mensajes recientes en
 *  vez de uno por conversación — a esta escala sobra. Cada chat sale marcado
 *  como restaurante o motorizado: es motorizado si su número está en la flota
 *  activa, que es justo a quien el bot atiende como tal. */
export async function listConversations() {
  const [conversations, recent, fleet] = await Promise.all([
    db.select().from(schema.conversations).orderBy(desc(schema.conversations.lastMessageAt)).limit(100),
    db.select().from(schema.messages).orderBy(desc(schema.messages.id)).limit(500),
    db.select({ name: schema.couriers.name, phone: schema.couriers.phone }).from(schema.couriers).where(eq(schema.couriers.active, true)),
  ]);

  const lastByConversation = new Map<number, (typeof recent)[number]>();
  for (const m of recent) if (!lastByConversation.has(m.conversationId)) lastByConversation.set(m.conversationId, m);

  const courierNameByPhone = new Map(fleet.map((courier) => [last10(courier.phone), courier.name]));

  return conversations
    .map((c) => {
      const last = lastByConversation.get(c.id);
      const courierName = courierNameByPhone.get(last10(c.phone)) ?? null;
      const kind: "restaurant" | "courier" = courierName === null ? "restaurant" : "courier";
      return {
        id: c.id,
        phone: c.phone,
        displayName: c.displayName,
        kind,
        courierName,
        botPaused: c.botPaused,
        escalationReason: c.escalationReason,
        draft: draftSummary(c.draft),
        lastMessageAt: c.lastMessageAt,
        lastText: last?.text ?? null,
        lastRole: last?.role ?? null,
      };
    })
    .sort((a, b) => Number(b.botPaused) - Number(a.botPaused));
}

export async function getThread(conversationId: number) {
  return db
    .select({ id: schema.messages.id, role: schema.messages.role, text: schema.messages.text, createdAt: schema.messages.createdAt })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.id));
}

/** "Intervenir": el operador toma el chat y el bot se calla en ese número. */
export async function takeOver(conversationId: number) {
  await db
    .update(schema.conversations)
    .set({ botPaused: true, escalationReason: "Un operador tomó la conversación.", draft: null, failedAttempts: 0 })
    .where(eq(schema.conversations.id, conversationId));
}

/** "Devolver al bot": el asesor terminó y el bot vuelve a atender ese chat. */
export async function resumeBot(conversationId: number) {
  await db
    .update(schema.conversations)
    .set({ botPaused: false, escalationReason: null, draft: null, failedAttempts: 0 })
    .where(eq(schema.conversations.id, conversationId));
}

/**
 * El borrador del bot en la forma que muestra el panel. El bot arma un pedido
 * con una o varias entregas; el panel muestra la última que va armando. Un
 * borrador vacío no se muestra.
 */
function draftSummary(raw: unknown): DraftFields | null {
  if (!raw) return null;
  const draft = normalizeDraft(raw);
  const delivery = draft.entregas[draft.entregas.length - 1];
  if (!delivery && !draft.origenRestaurante) return null;
  return {
    origenRestaurante: draft.origenRestaurante,
    direccionEntrega: delivery?.direccionEntrega ?? null,
    telefonoCliente: delivery?.telefonoCliente ?? null,
    valorACobrar: delivery?.valorACobrar ?? null,
    metodoPago: delivery?.metodoPago ?? null,
  };
}
