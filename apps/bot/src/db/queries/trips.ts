import { db, schema } from "@dispatch/shared/db";
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
) {
  const [trip] = await db
    .insert(schema.trips)
    .values({
      code: generateTripCode(),
      conversationId,
      status: "pending",
      originRestaurantName: fields.origenRestaurante,
      deliveryAddress: fields.direccionEntrega,
      deliveryLocation,
      customerPhone: fields.telefonoCliente,
      valueToCollect: fields.valorACobrar,
      paymentMethod: fields.metodoPago,
      requiresCashReturn: requiresCashReturn(fields.metodoPago),
      deliveryFee: fare.price,
      pickupZone: fare.pickupZone,
      deliveryZone: fare.deliveryZone,
    })
    .returning();
  return trip;
}
