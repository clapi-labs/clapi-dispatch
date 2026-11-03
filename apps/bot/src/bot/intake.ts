import { and, asc, eq, gt, isNull, lte, max } from "drizzle-orm";

import { db, findRestaurantByPhone, schema } from "@dispatch/shared/db";

import { findCourier, handleCourier } from "@/bot/courier";
import { handleRestaurant } from "@/bot/order";
import { recordMessage, upsertConversationOnInbound, type Conversation } from "@/db/queries/conversation";
import { markRead, markReadAndTyping } from "@/services/whatsapp/client";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * Por el mismo número escriben dos tipos de personas:
 *
 * - **Motorizados** (su teléfono está en la flota): `bot/courier.ts`. Se les
 *   responde en el acto: tocan botones y esperan la confirmación.
 * - **Restaurantes** (cualquier otro número): `bot/order.ts`. Se espera un
 *   momento antes de responder, como haría una persona.
 */

/**
 * Cuánto espera el bot, desde el último mensaje del restaurante, antes de
 * responder. Cada mensaje nuevo reinicia la espera, así que un pedido enviado
 * en varios mensajes seguidos se responde una sola vez. A lo largo de la
 * espera se ve como una persona: primero el leído y después «escribiendo…».
 */
export const REPLY_DELAY_MS = 6_000;
const READ_AT = 0.25;
const TYPING_AT = 0.5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cómo queda el mensaje entrante en el hilo del portal. */
function asText(message: IncomingMessage) {
  switch (message.kind) {
    case "text":
      return message.text;
    case "button":
      return `[Botón] ${message.title}`;
    case "location":
      return `[Ubicación] ${message.label ?? `${message.lat}, ${message.lng}`}`;
    case "image":
      return `[Imagen]${message.caption ? ` ${message.caption}` : ""}`;
    default:
      return `[${message.type}]`;
  }
}

function asPayload(message: IncomingMessage): schema.IncomingPayload {
  return { ...content(message), replyTo: message.replyTo ?? null };
}

function content(message: IncomingMessage): schema.IncomingPayload {
  switch (message.kind) {
    case "text":
      return { kind: "text", text: message.text };
    case "button":
      return { kind: "button", buttonId: message.buttonId, title: message.title };
    case "location":
      return { kind: "location", lat: message.lat, lng: message.lng, label: message.label };
    case "image":
      return { kind: "image", mediaId: message.mediaId, caption: message.caption };
    default:
      return { kind: "unsupported", type: message.type };
  }
}

export async function handleIncoming(message: IncomingMessage) {
  const conversation = await upsertConversationOnInbound(message.phone, message.profileName);
  const messageId = await recordMessage(conversation.id, "restaurant", asText(message), {
    waMessageId: message.waMessageId,
    incoming: asPayload(message),
  });

  // El motorizado va primero: su «Terminé el servicio» tiene que funcionar
  // siempre, aunque la central haya tomado su chat. Solo leído: casi nunca
  // se le responde, y un «escribiendo…» sin respuesta confunde.
  const courier = await findCourier(message.phone);
  if (courier) {
    await markRead(message.waMessageId);
    return handleCourier(courier, conversation, message);
  }

  // Con un asesor al frente, el bot no contesta nada: escuchar y callar.
  // Tampoco marca leído: eso le toca al asesor.
  if (conversation.botPaused) return;

  // Espera natural. Si en medio llega otro mensaje, este se retira: el más
  // reciente es el que responde, con todo lo acumulado.
  await sleep(REPLY_DELAY_MS * READ_AT);
  if (!(await isLatest(conversation.id, messageId))) return;
  await markRead(message.waMessageId);

  await sleep(REPLY_DELAY_MS * (TYPING_AT - READ_AT));
  if (!(await isLatest(conversation.id, messageId))) return;
  await markReadAndTyping(message.waMessageId);

  await sleep(REPLY_DELAY_MS * (1 - TYPING_AT));
  if (!(await isLatest(conversation.id, messageId))) return;

  const pending = await claimPending(conversation, messageId);
  for (const turn of mergeTurns(pending, message)) {
    // Se relee en cada turno: el anterior pudo cambiar el borrador o pausar el bot.
    const [fresh] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
    if (!fresh || fresh.botPaused) return;
    const restaurant = await findRestaurantByPhone(message.phone);
    await handleRestaurant({ conversation: fresh, message: turn, restaurant });
  }
}

/** ¿Sigue siendo el último mensaje del restaurante en esta conversación? */
async function isLatest(conversationId: number, messageId: number) {
  const [row] = await db
    .select({ last: max(schema.messages.id) })
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.role, "restaurant")));
  return row?.last === messageId;
}

/**
 * Los mensajes del restaurante que todavía no se respondieron, hasta
 * `throughId`. Marca la conversación como procesada hasta ahí con un UPDATE
 * condicional: si dos esperas terminan a la vez, solo una se los lleva.
 */
async function claimPending(conversation: Conversation, throughId: number) {
  const previous = conversation.processedThroughMessageId;
  const claimed = await db
    .update(schema.conversations)
    .set({ processedThroughMessageId: throughId })
    .where(
      and(
        eq(schema.conversations.id, conversation.id),
        previous === null
          ? isNull(schema.conversations.processedThroughMessageId)
          : eq(schema.conversations.processedThroughMessageId, previous),
      ),
    )
    .returning({ id: schema.conversations.id });
  if (!claimed.length) return [];

  return db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversation.id),
        eq(schema.messages.role, "restaurant"),
        previous === null ? undefined : gt(schema.messages.id, previous),
        lte(schema.messages.id, throughId),
      ),
    )
    .orderBy(asc(schema.messages.id));
}

/**
 * Los textos seguidos se juntan en uno: «Calle 48 # 98-20» + «apto 402» +
 * «en 10» es un solo pedido. Un botón o una ubicación van aparte, en su
 * orden. El texto juntado conserva el wamid del primero, que es el que se
 * cita en los avisos.
 */
function mergeTurns(rows: (typeof schema.messages.$inferSelect)[], from: IncomingMessage): IncomingMessage[] {
  const turns: IncomingMessage[] = [];
  for (const row of rows) {
    const payload = row.incoming ?? { kind: "text" as const, text: row.text };
    const base = { phone: from.phone, profileName: from.profileName, waMessageId: row.waMessageId ?? `msg-${row.id}`, timestamp: row.createdAt, replyTo: payload.replyTo ?? null };
    const last = turns[turns.length - 1];
    // Una foto se lee junto con el texto que la rodea: «este pedido» + captura.
    const piece =
      payload.kind === "image"
        ? { text: payload.caption ?? "", images: [payload.mediaId] }
        : payload.kind === "text"
          ? { text: payload.text, images: [] }
          : null;
    if (piece && last?.kind === "text") {
      last.text = [last.text, piece.text].filter(Boolean).join("\n");
      if (piece.images.length) last.images = [...(last.images ?? []), ...piece.images];
      continue;
    }
    if (piece) {
      turns.push({ ...base, kind: "text", text: piece.text, ...(piece.images.length ? { images: piece.images } : {}) });
      continue;
    }
    turns.push({ ...base, ...payload } as IncomingMessage);
  }
  return turns;
}
