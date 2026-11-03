import { and, desc, eq, gt, inArray } from "drizzle-orm";

import { codesForNumber, db, nextTripCode, schema, tripNumbersInText, type Restaurant } from "@dispatch/shared/db";
import { fullAddress, requiresCashReturn, type DeliveryDraft } from "@dispatch/shared";

/** El viaje de una entrega del pedido confirmado. Quien llama ya comprobó
 *  que trae los datos obligatorios de la agencia. */
export async function createTrip(
  conversationId: number,
  order: { origenRestaurante: string; mensajeOrigen: string | null },
  draft: DeliveryDraft,
  price: number,
  /** La recogida de un restaurante sin registrar, ubicada desde lo que escribió. */
  pickup: { address: string; location: { lat: number; lng: number } } | null,
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
      code: await nextTripCode(),
      conversationId,
      restaurantId: restaurant?.id ?? null,
      status: "pending",
      originRestaurantName: order.origenRestaurante,
      // Del registro del restaurante: ya geocodificada una vez, no por pedido.
      pickupAddress: restaurant?.knownPickupAddress ?? pickup?.address ?? null,
      pickupLocation: restaurant?.knownPickupLocation ?? pickup?.location ?? null,
      deliveryAddress: fullAddress(draft),
      deliveryLocation: draft.ubicacionEntrega ?? null,
      customerPhone: draft.telefonoCliente,
      customerName: draft.nombreCliente ?? null,
      valueToCollect: draft.valorACobrar,
      paymentMethod: draft.metodoPago,
      requiresCashReturn: requiresCashReturn(draft.metodoPago),
      notes: draft.notas ?? null,
      sourceWaMessageId: order.mensajeOrigen,
      readyAt,
      deliveryFee: price,
    })
    .returning();
  return trip;
}

export type Trip = typeof schema.trips.$inferSelect;

/** Los pedidos de esta conversación que siguen vivos (sin entregar ni
 *  cancelar) de las últimas 12 horas, el más reciente primero. */
export async function openTrips(conversationId: number): Promise<Trip[]> {
  return db
    .select()
    .from(schema.trips)
    .where(
      and(
        eq(schema.trips.conversationId, conversationId),
        inArray(schema.trips.status, ["pending", "assigned", "en_route"]),
        gt(schema.trips.createdAt, new Date(Date.now() - 12 * 60 * 60_000)),
      ),
    )
    .orderBy(desc(schema.trips.createdAt));
}

/**
 * El pedido del que habla un mensaje citado: el restaurante respondió a uno
 * de nuestros avisos (cada mensaje guarda su viaje) o al suyo propio con que
 * pidió el domicilio.
 */
export async function tripFromQuote(conversationId: number, quotedWaMessageId: string): Promise<Trip | null> {
  const [byMessage] = await db
    .select({ trip: schema.trips })
    .from(schema.messages)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.messages.tripId))
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.waMessageId, quotedWaMessageId)))
    .limit(1);
  if (byMessage) return byMessage.trip;

  const [bySource] = await db
    .select()
    .from(schema.trips)
    .where(and(eq(schema.trips.conversationId, conversationId), eq(schema.trips.sourceWaMessageId, quotedWaMessageId)))
    .limit(1);
  return bySource ?? null;
}

/**
 * El pedido que el restaurante nombra por su código en el texto («¿ya llegó
 * el A1042?», «el pedido 1042 ya está listo»), si es suyo. Con varios
 * códigos en el mismo mensaje, el primero que exista.
 */
export async function tripFromCodeInText(conversationId: number, text: string): Promise<Trip | null> {
  for (const number of tripNumbersInText(text)) {
    const [trip] = await db
      .select()
      .from(schema.trips)
      .where(and(eq(schema.trips.conversationId, conversationId), inArray(schema.trips.code, codesForNumber(number))))
      .limit(1);
    if (trip) return trip;
  }
  return null;
}

export async function getTrip(tripId: number): Promise<Trip | null> {
  const [trip] = await db.select().from(schema.trips).where(eq(schema.trips.id, tripId));
  return trip ?? null;
}

export async function updateTrip(tripId: number, patch: Partial<Trip>) {
  const [trip] = await db
    .update(schema.trips)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.trips.id, tripId))
    .returning();
  return trip;
}
