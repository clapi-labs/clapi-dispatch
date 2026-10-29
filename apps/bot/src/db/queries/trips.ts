import { db, schema, type Restaurant } from "@dispatch/shared/db";
import { requiresCashReturn, type OrderDraft } from "@dispatch/shared";

/** "D-7F3K2": un prefijo que distingue un código de viaje a simple vista de
 *  un `#PEDIDO` de catálogo, por si algún día conviven en el mismo número. */
function generateTripCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // sin 0/O/1/I: se lee por WhatsApp
  let code = "";
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `D-${code}`;
}

/** El viaje a partir del borrador confirmado. Quien llama ya comprobó que
 *  trae los datos obligatorios de la agencia. */
export async function createTrip(
  conversationId: number,
  draft: OrderDraft & { origenRestaurante: string; direccionEntrega: string },
  fare: { price: number; pickupZone: string | null; deliveryZone: string | null },
  restaurant: Restaurant | null,
) {
  const readyAt =
    draft.listoEnMinutos == null
      ? null
      : // Contado desde el mensaje que dio el tiempo, no desde ahora: si llegó
        // unos mensajes antes, contar desde ahora haría salir tarde a la moto.
        new Date((draft.listoDesde ? Date.parse(draft.listoDesde) : Date.now()) + draft.listoEnMinutos * 60_000);

  const [trip] = await db
    .insert(schema.trips)
    .values({
      code: generateTripCode(),
      conversationId,
      restaurantId: restaurant?.id ?? null,
      status: "pending",
      originRestaurantName: draft.origenRestaurante,
      // Del registro del restaurante: ya geocodificada una vez, no por pedido.
      pickupAddress: restaurant?.knownPickupAddress ?? null,
      pickupLocation: restaurant?.knownPickupLocation ?? null,
      deliveryAddress: draft.direccionEntrega,
      deliveryLocation: draft.ubicacionEntrega ?? null,
      customerPhone: draft.telefonoCliente,
      customerName: draft.nombreCliente ?? null,
      valueToCollect: draft.valorACobrar,
      paymentMethod: draft.metodoPago,
      requiresCashReturn: requiresCashReturn(draft.metodoPago),
      notes: draft.notas ?? null,
      sourceWaMessageId: draft.mensajeOrigen ?? null,
      readyAt,
      deliveryFee: fare.price,
      pickupZone: fare.pickupZone,
      deliveryZone: fare.deliveryZone,
    })
    .returning();
  return trip;
}
