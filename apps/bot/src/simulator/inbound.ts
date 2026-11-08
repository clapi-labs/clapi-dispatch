import { eq } from "drizzle-orm";

import { controlledBy, controllerOf, db, schema, simulatorEnabled } from "@dispatch/shared/db";

import { parseCourierButton } from "@/bot/notify";
import type { IncomingMessage } from "@/services/whatsapp/types";

type Courier = typeof schema.couriers.$inferSelect;

/**
 * Lo que escribe o toca un número de prueba lo hace, para el sistema, la moto
 * simulada que controla (docs/OPERACION.md, «Simulador»): queda en el chat de la
 * moto y aplica a sus pedidos. Los botones traen el pedido, así que se resuelven
 * por el pedido; el texto, por la moto que controla en ese momento. `null` si no
 * es un número de prueba o no controla ninguna moto: se atiende como siempre.
 */
export async function simulatedSender(sender: Courier, message: IncomingMessage): Promise<Courier | null> {
  if (!simulatorEnabled() || sender.simulated || (sender.status !== "available" && sender.status !== "busy")) return null;

  const button = message.kind === "button" ? parseCourierButton(message.buttonId) : null;
  if (button) {
    const [row] = await db
      .select({ courier: schema.couriers })
      .from(schema.assignments)
      .innerJoin(schema.couriers, eq(schema.couriers.id, schema.assignments.courierId))
      .where(eq(schema.assignments.tripId, button.tripId))
      .limit(1);
    if (row?.courier.simulated && (await controllerOf(row.courier.id))?.id === sender.id) return row.courier;
  }
  // Un botón de un pedido que ya no es de su moto llega a la moto que controla
  // ahora: ahí no es suyo, y el flujo lo dice sin cambiar nada.
  return controlledBy(sender.id);
}
