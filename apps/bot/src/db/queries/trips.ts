import { db, schema, type Restaurant } from "@dispatch/shared/db";
import { requiresCashReturn, type ResolvedTripFields } from "@dispatch/shared";

/** "D-7F3K2": un prefijo que distingue un código de viaje a simple vista de
 *  un `#PEDIDO` de catálogo, por si algún día conviven en el mismo número. */
function generateTripCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // sin 0/O/1/I: se lee por WhatsApp
  let code = "";
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `D-${code}`;
}

export async function createTrip(
  conversationId: number,
  fields: ResolvedTripFields,
  fare: { price: number; pickupZone: string | null; deliveryZone: string | null },
  deliveryLocation: { lat: number; lng: number } | null,
  restaurant: Restaurant | null,
) {
  const [trip] = await db
    .insert(schema.trips)
    .values({
      code: generateTripCode(),
      conversationId,
      restaurantId: restaurant?.id ?? null,
      status: "pending",
      originRestaurantName: fields.origenRestaurante,
      // Del registro del restaurante: ya geocodificada una vez, no por pedido.
      pickupAddress: restaurant?.knownPickupAddress ?? null,
      pickupLocation: restaurant?.knownPickupLocation ?? null,
      deliveryAddress: fields.direccionEntrega,
      deliveryLocation,
      customerPhone: fields.telefonoCliente,
      valueToCollect: fields.valorACobrar,
      paymentMethod: fields.metodoPago,
      requiresCashReturn: requiresCashReturn(fields.metodoPago),
      // Contado desde el mensaje que dio el tiempo, no desde ahora: si llegó
      // unos mensajes antes, contar desde ahora haría salir tarde a la moto.
      readyAt: new Date((fields.listoDesde ? Date.parse(fields.listoDesde) : Date.now()) + fields.listoEnMinutos * 60_000),
      deliveryFee: fare.price,
      pickupZone: fare.pickupZone,
      deliveryZone: fare.deliveryZone,
    })
    .returning();
  return trip;
}
