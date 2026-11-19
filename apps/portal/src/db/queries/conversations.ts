import { and, asc, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db, needsHelpCondition, schema } from "@dispatch/shared/db";
import { normalizeDraft } from "@dispatch/shared";
import { mediaConfig } from "@dispatch/shared/media";

import type { AdvisorQueryItem, ChatMessage, DraftFields } from "@/lib/types";

import { needsHelp, TAKEOVER_REASON } from "@/lib/chat";
import { mediaOf } from "@/lib/media";
import { THREAD_PAGE, type ThreadPage } from "@/lib/thread";

/** La misma regla que `findCourier` en el bot (apps/bot/src/bot/intake.ts): un
 *  motorizado guardado como "3001234567" y el wa_id "573001234567" de
 *  WhatsApp son la misma persona. */
function last10(phone: string) {
  return phone.replace(/\D/g, "").slice(-10);
}

/** Cuántos chats trae la bandeja. */
export const INBOX_LIMIT = 100;

/** El último mensaje de cada chat de la bandeja, con un `LATERAL`: una lectura
 *  del índice `(conversation_id, id)` por chat (~1 ms los 100). Antes se
 *  tomaban los últimos 500 mensajes de toda la base, y con mucho tráfico los
 *  chats de hace unas horas quedaban sin vista previa (H1 en
 *  docs/CAPACIDAD-CONVERSACIONES.md). Los chats salen en el mismo orden que la
 *  bandeja. */
async function lastMessages(limit: number) {
  const { rows } = await db.execute<{ conversation_id: number; text: string; role: ChatMessage["role"] }>(sql`
    select c.id as conversation_id, m.text, m.role
    from (
      select id from ${schema.conversations}
      order by ${schema.conversations.lastMessageAt} desc, ${schema.conversations.id} desc
      limit ${limit}
    ) c
    cross join lateral (
      select text, role from ${schema.messages}
      where ${schema.messages.conversationId} = c.id
      order by ${schema.messages.id} desc
      limit 1
    ) m`);
  return rows;
}

/** La bandeja: cada conversación con su último mensaje. Arriba, fijados, los
 *  que piden ayuda (ver `needsHelp` en lib/chat.ts); después los que ya atiende
 *  un asesor; después el resto, el más reciente primero. Cada chat sale marcado
 *  como restaurante o motorizado: es motorizado si su número está en la flota
 *  activa, que es justo a quien el bot atiende como tal; y si su número está en
 *  Restaurantes activos, conserva su nombre registrado aunque WhatsApp tenga otro. */
export async function listConversations() {
  const [conversations, recent, fleet, restaurants] = await Promise.all([
    db
      .select()
      .from(schema.conversations)
      .orderBy(desc(schema.conversations.lastMessageAt), desc(schema.conversations.id))
      .limit(INBOX_LIMIT),
    lastMessages(INBOX_LIMIT),
    db
      .select({ name: schema.couriers.name, phone: schema.couriers.phone, photo: schema.couriers.photo })
      .from(schema.couriers)
      .where(eq(schema.couriers.active, true)),
    db
      .select({ name: schema.restaurants.name, phone: schema.restaurants.phone, photo: schema.restaurants.photo })
      .from(schema.restaurants)
      .where(and(eq(schema.restaurants.active, true), isNotNull(schema.restaurants.phone))),
  ]);

  const lastByConversation = new Map(recent.map((m) => [Number(m.conversation_id), m]));

  const courierByPhone = new Map(fleet.map((c) => [last10(c.phone), { name: c.name, photo: c.photo }]));
  const restaurantByPhone = new Map(restaurants.flatMap((r) => (r.phone ? [[last10(r.phone), { name: r.name, photo: r.photo }]] : [])));

  return conversations
    .map((c) => {
      const last = lastByConversation.get(c.id);
      const phoneKey = last10(c.phone);
      const courier = courierByPhone.get(phoneKey) ?? null;
      const restaurant = courier === null ? (restaurantByPhone.get(phoneKey) ?? null) : null;
      const courierName = courier?.name ?? null;
      const restaurantName = restaurant?.name ?? null;
      const kind: "restaurant" | "courier" = courier === null ? "restaurant" : "courier";
      return {
        id: c.id,
        phone: c.phone,
        displayName: c.displayName,
        kind,
        courierName,
        restaurantName,
        photo: courier?.photo ?? restaurant?.photo ?? null,
        botPaused: c.botPaused,
        escalationReason: c.escalationReason,
        draft: draftSummary(c.draft),
        advisorQuery: advisorQuery(c.draft),
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

/** Qué chats piden ayuda: la burbuja amarilla de la navegación (su cuenta) y,
 *  por id, el timbre (un chat que entra mientras otro sale no cambia la
 *  cuenta, pero sí suena). Es `needsHelp` (lib/chat.ts) en SQL, la misma
 *  condición con que el servidor avisa al celular (`needsHelpCondition` en
 *  @dispatch/shared). */
export async function idsNeedingHelp(): Promise<number[]> {
  const rows = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(needsHelpCondition());
  return rows.map((r) => r.id);
}

/** Lo más que trae una sola página; con `after`, si hay más nuevos que esto, se
 *  devuelve la última página entera (`reset`). */
export const THREAD_MAX_PAGE = 200;

const threadColumns = {
  id: schema.messages.id,
  role: schema.messages.role,
  text: schema.messages.text,
  createdAt: schema.messages.createdAt,
  waMessageId: schema.messages.waMessageId,
  replyTo: schema.messages.replyToWaMessageId,
  // Del mensaje entrante solo hace falta a cuál cita, no el JSON entero.
  incomingReplyTo: sql<string | null>`${schema.messages.incoming} ->> 'replyTo'`,
  mediaStatus: schema.messages.mediaStatus,
  mediaMime: schema.messages.mediaMime,
  mediaBytes: schema.messages.mediaBytes,
  mediaWidth: schema.messages.mediaWidth,
  mediaHeight: schema.messages.mediaHeight,
  mediaExpiredReason: schema.messages.mediaExpiredReason,
};

type ThreadRow = {
  id: number;
  role: ChatMessage["role"];
  text: string;
  createdAt: Date;
  waMessageId: string | null;
  replyTo: string | null;
  incomingReplyTo: string | null;
  mediaStatus: typeof schema.messages.$inferSelect.mediaStatus;
  mediaMime: string | null;
  mediaBytes: number | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  mediaExpiredReason: typeof schema.messages.$inferSelect.mediaExpiredReason;
};

/**
 * Los mensajes como en WhatsApp: cada uno con el que cita (si cita uno) y los
 * códigos de los pedidos que salieron de él. Así, en el portal se ve a qué
 * pedido responde cada aviso, igual que en el celular. La cita puede ser de un
 * mensaje que no está en la página: se busca aparte, por su wamid.
 */
async function decorate(conversationId: number, rows: ThreadRow[]): Promise<ChatMessage[]> {
  if (rows.length === 0) return [];
  const { retentionDays } = mediaConfig();
  const byWaId = new Map(rows.filter((m) => m.waMessageId).map((m) => [m.waMessageId!, { id: m.id, role: m.role, text: m.text }]));
  const missing = [...new Set(rows.map((m) => m.replyTo ?? m.incomingReplyTo).filter((q): q is string => !!q && !byWaId.has(q)))];
  const sources = rows.filter((m) => m.role === "restaurant" && m.waMessageId).map((m) => m.waMessageId!);

  const [quoted, trips] = await Promise.all([
    missing.length === 0
      ? []
      : db
          .select({ id: schema.messages.id, role: schema.messages.role, text: schema.messages.text, waMessageId: schema.messages.waMessageId })
          .from(schema.messages)
          .where(and(eq(schema.messages.conversationId, conversationId), inArray(schema.messages.waMessageId, missing))),
    sources.length === 0
      ? []
      : db
          .select({ code: schema.trips.code, source: schema.trips.sourceWaMessageId })
          .from(schema.trips)
          .where(and(eq(schema.trips.conversationId, conversationId), inArray(schema.trips.sourceWaMessageId, sources)))
          .orderBy(asc(schema.trips.id)),
  ]);
  for (const q of quoted) if (q.waMessageId && !byWaId.has(q.waMessageId)) byWaId.set(q.waMessageId, { id: q.id, role: q.role, text: q.text });
  const codesBySource = new Map<string, string[]>();
  for (const t of trips) if (t.source) codesBySource.set(t.source, [...(codesBySource.get(t.source) ?? []), t.code]);

  return rows.map((m) => {
    const quotedId = m.replyTo ?? m.incomingReplyTo ?? null;
    const quote = quotedId ? byWaId.get(quotedId) : undefined;
    // La etiqueta va en el mensaje con que el restaurante pidió: ahí nace el
    // pedido. Los avisos del bot ya dicen el código en el texto.
    const own = m.role === "restaurant" && m.waMessageId ? (codesBySource.get(m.waMessageId) ?? []) : [];
    return {
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
      quote: quote ?? null,
      tripCodes: own,
      media: mediaOf(m, retentionDays),
    };
  });
}

/** El hilo entero, del más viejo al más nuevo. Lo siguen pidiendo las pestañas
 *  abiertas antes del hilo paginado; el portal de ahora usa `getThreadPage`. */
export async function getThread(conversationId: number): Promise<ChatMessage[]> {
  const rows = await db
    .select(threadColumns)
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.id));
  return decorate(conversationId, rows);
}

export type ThreadQuery = { before?: number; after?: number; limit?: number };

/**
 * El hilo por páginas (H2 en docs/CAPACIDAD-CONVERSACIONES.md):
 *
 * - sin nada: los últimos `limit` mensajes (al abrir el chat);
 * - `before`: los `limit` anteriores a ese id («Cargar anteriores»);
 * - `after`: los posteriores a ese id, para ponerse al día sin volver a bajar
 *   el hilo. El portal pide desde unos mensajes antes del último que tiene,
 *   así ve también los que cambiaron (un «No se pudo entregar» de Meta).
 *
 * Siempre en orden, del más viejo al más nuevo.
 */
export async function getThreadPage(conversationId: number, query: ThreadQuery = {}): Promise<ThreadPage> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? THREAD_PAGE), 1), THREAD_MAX_PAGE);
  const inChat = eq(schema.messages.conversationId, conversationId);

  if (query.after !== undefined) {
    const rows = await db
      .select(threadColumns)
      .from(schema.messages)
      .where(and(inChat, gt(schema.messages.id, query.after)))
      .orderBy(asc(schema.messages.id))
      .limit(THREAD_MAX_PAGE + 1);
    if (rows.length > THREAD_MAX_PAGE) return { ...(await getThreadPage(conversationId, { limit })), reset: true };
    return { messages: await decorate(conversationId, rows), hasOlder: null, reset: false };
  }

  const rows = await db
    .select(threadColumns)
    .from(schema.messages)
    .where(query.before !== undefined ? and(inChat, lt(schema.messages.id, query.before)) : inChat)
    .orderBy(desc(schema.messages.id))
    .limit(limit + 1);
  const hasOlder = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: await decorate(conversationId, page), hasOlder, reset: false };
}

/** "Intervenir": el operador toma el chat y el bot se calla en ese número. */
export async function takeOver(conversationId: number) {
  await db
    .update(schema.conversations)
    .set({ botPaused: true, escalationReason: TAKEOVER_REASON, draft: null, failedAttempts: 0 })
    .where(eq(schema.conversations.id, conversationId));
}

/** "Devolver al bot": el asesor terminó y el bot vuelve a atender ese chat.
 *  Con `onlyIfTakeover`, solo aplica si el bot fue pausado manualmente con
 *  "Intervenir", para no cerrar por error un escalado ni una emergencia. */
export async function resumeBot(conversationId: number, { onlyIfTakeover = false } = {}) {
  await db
    .update(schema.conversations)
    .set({ botPaused: false, escalationReason: null, draft: null, failedAttempts: 0 })
    .where(
      onlyIfTakeover
        ? and(eq(schema.conversations.id, conversationId), eq(schema.conversations.escalationReason, TAKEOVER_REASON))
        : eq(schema.conversations.id, conversationId),
    );
}

/** Las entregas que el bot le preguntó a la central (ver `askAdvisor` y
 *  `askCoverage` en apps/bot/src/bot/order.ts). `null` si no hay consulta
 *  pendiente. */
function advisorQuery(raw: unknown): AdvisorQueryItem[] | null {
  if (!raw) return null;
  const draft = normalizeDraft(raw);
  if (!draft.consultaAsesor) return null;
  return draft.consultaAsesor.entregas.flatMap((indice) => {
    const d = draft.entregas[indice];
    if (!d?.direccionEntrega) return [];
    const direccion = [d.direccionEntrega, d.detalleDireccion].filter(Boolean).join(" · ");
    const near = draft.consultaAsesor!.motivo === "cobertura" ? draft.consultaAsesor!.cobertura?.find((c) => c.indice === indice) : undefined;
    const cobertura = near ? { zona: near.zona, metros: near.metros, precio: near.precio, km: near.km ?? null, porCalle: near.fuente === "calle" } : null;
    return [{ indice, direccion, barrio: d.barrio ?? null, cliente: d.nombreCliente ?? null, cobertura }];
  });
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
