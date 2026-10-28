import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

import { needsHelp, TAKEOVER_REASON } from "@/lib/chat";

/** La misma regla que `findCourier` en el bot (apps/bot/src/bot/intake.ts): un
 *  motorizado guardado como "3001234567" y el wa_id "573001234567" de
 *  WhatsApp son la misma persona. */
function last10(phone: string) {
  return phone.replace(/\D/g, "").slice(-10);
}

/** La bandeja: cada conversación con su último mensaje. Arriba, fijados, los
 *  que piden ayuda (ver `needsHelp` en lib/chat.ts); después los que ya atiende
 *  un asesor; después el resto, el más reciente primero. Un solo SELECT de mensajes recientes en
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
        draft: c.draft,
        lastMessageAt: c.lastMessageAt,
        lastText: last?.text ?? null,
        lastRole: last?.role ?? null,
      };
    })
    .sort((a, b) => pinRank(b) - pinRank(a));
}

/** 2 = pide ayuda, 1 = la atiende un asesor, 0 = la atiende el bot. */
function pinRank(c: Parameters<typeof needsHelp>[0]) {
  if (needsHelp(c)) return 2;
  return c.botPaused ? 1 : 0;
}

/** Cuántos chats piden ayuda: la burbuja amarilla de la navegación. Es
 *  `needsHelp` (lib/chat.ts) en SQL: escalado por el bot, y lo último no lo
 *  escribió la central. */
export async function countNeedingHelp(): Promise<number> {
  const lastRole = sql`(select ${schema.messages.role} from ${schema.messages}
    where ${schema.messages.conversationId} = ${schema.conversations.id}
    order by ${schema.messages.id} desc limit 1)`;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.botPaused, true),
        sql`${schema.conversations.escalationReason} is distinct from ${TAKEOVER_REASON}`,
        sql`coalesce(${lastRole}, '') <> 'agent'`,
      ),
    );
  return row?.n ?? 0;
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
    .set({ botPaused: true, escalationReason: TAKEOVER_REASON, draft: null, failedAttempts: 0 })
    .where(eq(schema.conversations.id, conversationId));
}

/** "Devolver al bot": el asesor terminó y el bot vuelve a atender ese chat. */
export async function resumeBot(conversationId: number) {
  await db
    .update(schema.conversations)
    .set({ botPaused: false, escalationReason: null, draft: null, failedAttempts: 0 })
    .where(eq(schema.conversations.id, conversationId));
}
