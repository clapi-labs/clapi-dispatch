import { and, eq, isNotNull, sql } from "drizzle-orm";

import {
  CLOSING_REMINDER_MINUTES,
  closingReminderMessage,
  lastOpening,
  minutesLeft,
  normalizeDraft,
} from "@dispatch/shared";
import { db, getServiceHours, hoursFor, listRestaurants, normalizePhone, schema } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";

/**
 * El cierre de cada restaurante (docs/BOT.md, «Horario»). Lo llama el tick:
 *
 * - Faltando `CLOSING_REMINDER_MINUTES` para su hora límite, a quien tiene un
 *   pedido a medio armar se le recuerda que lo confirme antes. Una vez por
 *   pedido: la marca va en el borrador y se pone con un UPDATE condicional,
 *   así que dos ticks a la vez no lo mandan dos veces.
 * - Pasada la hora límite, ese pedido se descarta: ya no se recibe, aunque
 *   haya empezado antes. Si el restaurante escribe, recibe el aviso de fuera
 *   de horario (`bot/order.ts`).
 *
 * Solo cuenta lo que el bot está atendiendo: con la central al frente del
 * chat (bot en pausa) no se toca nada. Devuelve las conversaciones avisadas.
 */
export async function handleClosing(now = new Date()): Promise<number[]> {
  const drafts = await db
    .select({ id: schema.conversations.id, phone: schema.conversations.phone, draft: schema.conversations.draft, lastInboundAt: schema.conversations.lastInboundAt })
    .from(schema.conversations)
    .where(and(isNotNull(schema.conversations.draft), eq(schema.conversations.botPaused, false)));
  const pending = drafts.filter((c) => normalizeDraft(c.draft).entregas.length > 0);
  if (!pending.length) return [];

  const hours = await getServiceHours();
  const byPhone = new Map(
    (await listRestaurants()).filter((r) => r.active && r.phone).map((r) => [normalizePhone(r.phone!).slice(-10), r] as const),
  );
  const opening = lastOpening(now, hours.opensAt);

  const reminded: number[] = [];
  for (const c of pending) {
    const restaurantHours = hoursFor(byPhone.get(normalizePhone(c.phone).slice(-10)) ?? null, hours);
    const left = minutesLeft(now, restaurantHours);
    const draft = normalizeDraft(c.draft);

    if (left === null) {
      await db
        .update(schema.conversations)
        .set({ draft: null, failedAttempts: 0 })
        .where(and(eq(schema.conversations.id, c.id), eq(schema.conversations.botPaused, false)));
      continue;
    }

    // Solo pedidos de esta jornada, y no una cotización suelta.
    const today = !!c.lastInboundAt && c.lastInboundAt >= opening;
    if (left > CLOSING_REMINDER_MINUTES || !today || draft.soloPrecio || draft.recordatorioCierre) continue;

    const [claimed] = await db
      .update(schema.conversations)
      .set({ draft: sql`${schema.conversations.draft} || '{"recordatorioCierre": true}'::jsonb` })
      .where(
        and(
          eq(schema.conversations.id, c.id),
          eq(schema.conversations.botPaused, false),
          isNotNull(schema.conversations.draft),
          sql`coalesce((${schema.conversations.draft}->>'recordatorioCierre')::boolean, false) = false`,
        ),
      )
      .returning({ id: schema.conversations.id });
    if (!claimed) continue;

    await say(c.id, c.phone, closingReminderMessage(restaurantHours.deadline), { replyTo: draft.mensajeOrigen });
    reminded.push(c.id);
  }
  return reminded;
}
