import { and, eq } from "drizzle-orm";

import { controllerOf, db, schema, simulatorEnabled } from "@dispatch/shared/db";

/**
 * Los mensajes de una moto simulada (docs/OPERACION.md, «Simulador»). Pasan por
 * el bot como los de cualquier moto y quedan en su chat del portal; a WhatsApp
 * solo salen si un número de prueba la controla, y van a ese número. Sin
 * `SIMULATOR_ENABLED` no cambia nada: cada moto recibe en su propio número.
 */

/** Los ids de los toques que hace el simulador por una moto que se maneja sola:
 *  no son de Meta, así que no se les marca leído. */
export const SIMULATED_ID_PREFIX = "sim-";

export type Route = { to: string; simName: null } | { to: string | null; simName: string };

export async function routeRecipient(to: string): Promise<Route> {
  if (!simulatorEnabled()) return { to, simName: null };
  const [sim] = await db
    .select({ id: schema.couriers.id, name: schema.couriers.name })
    .from(schema.couriers)
    .where(and(eq(schema.couriers.phone, to), eq(schema.couriers.simulated, true)))
    .limit(1);
  if (!sim) return { to, simName: null };
  const controller = await controllerOf(sim.id);
  return { to: controller?.phone ?? null, simName: sim.name };
}

/** A qué número salió cada mensaje desviado: una cita solo sirve en el chat
 *  donde está el mensaje citado. Se pierde al reiniciar, y ahí solo se deja de
 *  citar. */
const sentTo = new Map<string, string>();
const MAX_REMEMBERED = 5000;

export function rememberSent(messageId: string | null, phone: string) {
  if (!messageId) return;
  sentTo.set(messageId, phone);
  if (sentTo.size > MAX_REMEMBERED) sentTo.delete(sentTo.keys().next().value!);
}

/** El mensaje como le llega al número de prueba: con el nombre de la moto
 *  arriba, para saber de cuál habla. */
export function forTestNumber(payload: Record<string, unknown>, phone: string, simName: string): Record<string, unknown> {
  const header = `🧪 _Moto simulada: ${simName}_\n\n`;
  const next: Record<string, unknown> = { ...payload, to: phone };
  const context = payload.context as { message_id?: string } | undefined;
  if (context?.message_id && sentTo.get(context.message_id) !== phone) delete next.context;
  if (payload.type === "text") {
    const text = payload.text as { body: string };
    next.text = { ...text, body: header + text.body };
  } else if (payload.type === "interactive") {
    const interactive = payload.interactive as { body: { text: string } };
    next.interactive = { ...interactive, body: { text: header + interactive.body.text } };
  }
  return next;
}
