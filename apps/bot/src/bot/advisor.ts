import { eq } from "drizzle-orm";

import { fullAddress, normalizeDraft } from "@dispatch/shared";
import { db, findRestaurantByPhone, getBotConfig, schema } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { quoteMessage } from "@/bot/order";
import { updateConversation } from "@/db/queries/conversation";

/**
 * La respuesta de la central a una consulta de dirección (`askAdvisor` en
 * order.ts): el mapa no ubicó la dirección y el asesor dice, desde el
 * portal, si es válida y cuánto vale. El bot retoma la conversación con el
 * pedido como estaba: con el precio del asesor, o pidiéndole al restaurante
 * que corrija la dirección.
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
