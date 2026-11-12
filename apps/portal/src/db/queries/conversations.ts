import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db, needsHelpCondition, schema } from "@dispatch/shared/db";
import { normalizeDraft } from "@dispatch/shared";

import type { AdvisorQueryItem, ChatMessage, DraftFields } from "@/lib/types";

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

/** Cuántos chats piden ayuda: la burbuja amarilla de la navegación. Es
 *  `needsHelp` (lib/chat.ts) en SQL, la misma condición con que el servidor
 *  avisa al celular (`needsHelpCondition` en @dispatch/shared). */
export async function countNeedingHelp(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.conversations)
    .where(needsHelpCondition());
  return row?.n ?? 0;
}

/**
 * El hilo como en WhatsApp: cada mensaje con el que cita (si cita uno) y los
 * códigos de los pedidos que salieron de él o de los que habla. Así, en el
 * portal se ve a qué pedido responde cada aviso, igual que en el celular.
 */
export async function getThread(conversationId: number): Promise<ChatMessage[]> {
  const [rows, trips] = await Promise.all([
    db
      .select({
        id: schema.messages.id,
        role: schema.messages.role,
        text: schema.messages.text,
        createdAt: schema.messages.createdAt,
        waMessageId: schema.messages.waMessageId,
        replyTo: schema.messages.replyToWaMessageId,
        incoming: schema.messages.incoming,
        tripId: schema.messages.tripId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.id)),
    db
      .select({ id: schema.trips.id, code: schema.trips.code, source: schema.trips.sourceWaMessageId })
      .from(schema.trips)
      .where(eq(schema.trips.conversationId, conversationId)),
  ]);

  const byWaId = new Map(rows.filter((m) => m.waMessageId).map((m) => [m.waMessageId!, m]));
  const codesBySource = new Map<string, string[]>();
  for (const t of trips) if (t.source) codesBySource.set(t.source, [...(codesBySource.get(t.source) ?? []), t.code]);

  return rows.map((m) => {
    const quotedId = m.replyTo ?? m.incoming?.replyTo ?? null;
    const quoted = quotedId ? byWaId.get(quotedId) : undefined;
    // La etiqueta va en el mensaje con que el restaurante pidió: ahí nace el
    // pedido. Los avisos del bot ya dicen el código en el texto.
    const own = m.role === "restaurant" && m.waMessageId ? (codesBySource.get(m.waMessageId) ?? []) : [];
    return {
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
      quote: quoted ? { id: quoted.id, role: quoted.role, text: quoted.text } : null,
      tripCodes: own,
    };
  });
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
