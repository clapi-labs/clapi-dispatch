import { eq } from "drizzle-orm";

import { fullAddress, normalizeDraft } from "@dispatch/shared";
import { db, findRestaurantByPhone, getBotConfig, schema } from "@dispatch/shared/db";

import { noServiceText } from "@/bot/coverage";
import { say } from "@/bot/messaging";
import { quoteMessage } from "@/bot/order";
import { updateConversation } from "@/db/queries/conversation";

/**
 * La respuesta de la central a lo que el bot le preguntó desde el portal. El
 * bot retoma la conversación con el pedido como estaba.
 *
 * - Consulta de dirección (`askAdvisor` en order.ts): el mapa no ubicó la
 *   dirección y el asesor dice si es válida y cuánto vale. Sigue con el
 *   precio del asesor, o le pide al restaurante que corrija la dirección.
 * - Consulta de cobertura (`askCoverage`): la entrega quedó fuera de las zonas
 *   de servicio, cerca del borde, y el asesor dice si se hace. Si sí, sigue
 *   con el precio (el de la tabla por km, o el que ponga el asesor); si no, le
 *   dice al restaurante que hasta allá no hay domicilio y esa entrega no se pide.
 */

export type AdvisorAnswer = {
  /** Posición de la entrega en el pedido. */
  indice: number;
  valida: boolean;
  /** Lo que vale el domicilio, en pesos. Obligatorio si es válida. */
  precio?: number | null;
  /** La dirección corregida por el asesor («La 42» → «Calle 42 # 83E-15»). */
  direccion?: string | null;
};

export type AdvisorResult = { ok: true } | { ok: false; status: number; error: string };

export async function answerAdvisorQuery(conversationId: number, answers: AdvisorAnswer[]): Promise<AdvisorResult> {
  const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  if (!conversation) return { ok: false, status: 404, error: "No existe la conversación" };
  const draft = normalizeDraft(conversation.draft);
  const query = draft.consultaAsesor;
  if (!query) return { ok: false, status: 409, error: "Esta conversación no tiene una consulta de dirección pendiente" };

  if (query.motivo === "cobertura") return answerCoverage(conversation, draft, answers);

  const byIndex = new Map(answers.map((a) => [a.indice, a]));
  if (query.entregas.some((i) => !byIndex.has(i))) return { ok: false, status: 400, error: "Falta responder alguna dirección" };
  for (const i of query.entregas) {
    const a = byIndex.get(i)!;
    if (a.valida && !(Number.isInteger(a.precio) && a.precio! > 0)) return { ok: false, status: 400, error: "Falta el valor del domicilio" };
  }

  const invalid: string[] = [];
  for (const i of query.entregas) {
    const d = draft.entregas[i];
    const a = byIndex.get(i)!;
    if (!d) continue;
    if (a.direccion?.trim()) d.direccionEntrega = a.direccion.trim();
    if (a.valida) {
      Object.assign(d, { cotizacion: { precio: a.precio!, km: null }, direccionUbicada: d.direccionEntrega, validadaPorAsesor: true });
    } else {
      Object.assign(d, { cotizacion: null, direccionUbicada: null, validadaPorAsesor: false });
      invalid.push(`«${fullAddress(d)}»`);
    }
  }

  draft.consultaAsesor = null;
  const replyTo = draft.mensajeOrigen ?? null;
  if (invalid.length) {
    await updateConversation(conversationId, { botPaused: false, escalationReason: null, failedAttempts: 0, draft });
    await say(
      conversationId,
      conversation.phone,
      `La central no encuentra ${invalid.join(" ni ")} 🙏 ¿Me confirmas la dirección con el número completo y el barrio? También puedes enviarme la ubicación.`,
      { replyTo },
    );
    return { ok: true };
  }

  // Un precio nuevo siempre se muestra: con lo que falte, o completo para confirmar.
  const [config, restaurant] = await Promise.all([getBotConfig(), findRestaurantByPhone(conversation.phone)]);
  const quote = quoteMessage(draft, { config, restaurant, intro: "La central confirmó la dirección ✅" });
  draft.etapa = "cotizado";
  draft.resumenMostrado = quote.summary ?? null;
  await updateConversation(conversationId, { botPaused: false, escalationReason: null, failedAttempts: 0, draft });
  await say(conversationId, conversation.phone, quote.text, { replyTo, buttons: quote.buttons });
  return { ok: true };
}

type ConversationRow = typeof schema.conversations.$inferSelect;

async function answerCoverage(conversation: ConversationRow, draft: ReturnType<typeof normalizeDraft>, answers: AdvisorAnswer[]): Promise<AdvisorResult> {
  const query = draft.consultaAsesor!;
  const byIndex = new Map(answers.map((a) => [a.indice, a]));
  if (query.entregas.some((i) => !byIndex.has(i))) return { ok: false, status: 400, error: "Falta responder alguna entrega" };
  for (const i of query.entregas) {
    const a = byIndex.get(i)!;
    if (a.valida && !(Number.isInteger(a.precio) && a.precio! > 0)) return { ok: false, status: 400, error: "Falta el valor del domicilio" };
  }

  const refused = new Set<number>();
  for (const i of query.entregas) {
    const d = draft.entregas[i];
    const a = byIndex.get(i)!;
    if (!d) continue;
    if (a.valida) {
      const km = query.cobertura?.find((c) => c.indice === i)?.km ?? null;
      d.cotizacion = { precio: a.precio!, km };
    } else {
      refused.add(i);
    }
  }
  const labels = [...refused].map((i) => draft.entregas[i]).filter(Boolean).map((d) => d.barrio ?? d.direccionEntrega?.split(",")[0] ?? "la entrega");
  draft.entregas = draft.entregas.filter((_, i) => !refused.has(i));
  draft.consultaAsesor = null;

  const replyTo = draft.mensajeOrigen ?? null;
  const refusal = noServiceText(labels);
  // No quedó nada por pedir: el pedido no se crea.
  if (!draft.entregas.some((d) => d.cotizacion)) {
    await updateConversation(conversation.id, { botPaused: false, escalationReason: null, failedAttempts: 0, draft: null });
    await say(conversation.id, conversation.phone, refusal ?? "Qué pena, pero hasta allá no manejamos domicilio 🙏", { replyTo });
    return { ok: true };
  }

  const [config, restaurant] = await Promise.all([getBotConfig(), findRestaurantByPhone(conversation.phone)]);
  const intro = refused.size === query.entregas.length ? refusal : [refusal, "Confirmé con la central: sí llegamos ✅"].filter(Boolean).join("\n");
  const quote = quoteMessage(draft, { config, restaurant, intro: intro ?? undefined });
  draft.etapa = "cotizado";
  draft.resumenMostrado = quote.summary ?? null;
  await updateConversation(conversation.id, { botPaused: false, escalationReason: null, failedAttempts: 0, draft });
  await say(conversation.id, conversation.phone, quote.text, { replyTo, buttons: quote.buttons });
  return { ok: true };
}
