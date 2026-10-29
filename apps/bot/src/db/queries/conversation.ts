import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";

export type Conversation = typeof schema.conversations.$inferSelect;

/** El hilo lo identifica el teléfono del RESTAURANTE, no el del cliente
 *  final — ese llega como dato dentro del viaje, no como un hilo propio. */
export async function upsertConversationOnInbound(phone: string, profileName: string | null) {
  const now = new Date();

  const [existing] = await db.select().from(schema.conversations).where(eq(schema.conversations.phone, phone)).limit(1);

  if (existing) {
    const [updated] = await db
      .update(schema.conversations)
      .set({ lastInboundAt: now, ...(profileName ? { displayName: profileName } : {}) })
      .where(eq(schema.conversations.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(schema.conversations)
    .values({ phone, displayName: profileName, lastInboundAt: now })
    .returning();
  return created;
}

export async function updateConversation(id: number, patch: Partial<Conversation>) {
  await db.update(schema.conversations).set(patch).where(eq(schema.conversations.id, id));
}

export async function recordMessage(
  conversationId: number,
  role: schema.MessageRole,
  text: string,
  extra?: { waMessageId?: string | null; tripId?: number | null; extraction?: Conversation["draft"] },
) {
  await db.insert(schema.messages).values({
    conversationId,
    role,
    text,
    waMessageId: extra?.waMessageId ?? null,
    tripId: extra?.tripId ?? null,
    extraction: extra?.extraction ?? null,
  });

  await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conversationId));
}
