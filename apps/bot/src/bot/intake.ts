import { findRestaurantByPhone } from "@dispatch/shared/db";

import { findCourier, handleCourier } from "@/bot/courier";
import { handleRestaurant } from "@/bot/order";
import { recordMessage, upsertConversationOnInbound } from "@/db/queries/conversation";
import { markReadAndTyping } from "@/services/whatsapp/client";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * Por el mismo número escriben dos tipos de personas:
 *
 * - **Motorizados** (su teléfono está en la flota): `bot/courier.ts`.
 * - **Restaurantes** (cualquier otro número): `bot/order.ts`.
 */

/** Cómo queda el mensaje entrante en el hilo del portal. */
function asText(message: IncomingMessage) {
  switch (message.kind) {
    case "text":
      return message.text;
    case "button":
      return `[Botón] ${message.title}`;
    case "location":
      return `[Ubicación] ${message.label ?? `${message.lat}, ${message.lng}`}`;
    default:
      return `[${message.type}]`;
  }
}

export async function handleIncoming(message: IncomingMessage) {
  const conversation = await upsertConversationOnInbound(message.phone, message.profileName);
  await recordMessage(conversation.id, "restaurant", asText(message), { waMessageId: message.waMessageId });

  // El motorizado va primero: su "Confirmar entrega" tiene que funcionar
  // siempre, aunque alguien haya pausado el bot en su chat.
  const courier = await findCourier(message.phone);
  if (courier) {
    await markReadAndTyping(message.waMessageId);
    return handleCourier(courier, conversation, message);
  }

  // Con un asesor al frente, el bot no contesta nada: escuchar y callar.
  // Tampoco marca leído: eso le toca al asesor.
  if (conversation.botPaused) return;

  await markReadAndTyping(message.waMessageId);

  // Un restaurante registrado se reconoce por su número: el origen del pedido
  // es él, sin preguntarlo.
  const restaurant = await findRestaurantByPhone(message.phone);
  return handleRestaurant({ conversation, message, restaurant });
}
