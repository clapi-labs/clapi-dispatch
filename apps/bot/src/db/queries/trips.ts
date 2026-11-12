import { and, desc, eq, gt, inArray } from "drizzle-orm";

import { db, nextTripCode, schema, tripCodesInText, type Restaurant } from "@dispatch/shared/db";
import { fullAddress, requiresCashReturn, type DeliveryDraft } from "@dispatch/shared";

/** La recogida de un restaurante registrado, con su detalle ("Local 12") si lo tiene. */
function restaurantPickup(restaurant: Restaurant | null) {
  if (!restaurant?.knownPickupAddress) return null;
  return [restaurant.knownPickupAddress, restaurant.pickupDetail].filter(Boolean).join(", ");
}

/** El viaje de una entrega del pedido confirmado. Quien llama ya comprobó
 *  que trae los datos obligatorios de la agencia. */
export async function createTrip(
  /** Nulo en un pedido que no llegó por WhatsApp (el simulador): no hay a quién avisarle. */
  conversationId: number | null,
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
      pickupAddress: restaurantPickup(restaurant) ?? pickup?.address ?? null,
      pickupLocation: restaurant?.knownPickupLocation ?? pickup?.location ?? null,
      deliveryAddress: fullAddress(draft),
      deliveryLocation: draft.ubicacionEntrega ?? null,
      // Lo primero que ve el motorizado de a dónde va, antes de recoger.
      deliveryZone: draft.barrio ?? null,
      customerPhone: draft.telefonoCliente,
      customerName: draft.nombreCliente ?? null,
      valueToCollect: draft.valorACobrar,
      paymentMethod: draft.metodoPago,
      requiresCashReturn: requiresCashReturn(draft.metodoPago),
      notes: draft.notas ?? null,
      sourceWaMessageId: order.mensajeOrigen,
      readyAt,
      deliveryFee: price,
      // Los km con que se cotizó, para que el portal muestre los mismos.
      routeKm: draft.cotizacion?.km ?? null,
      routeSource: draft.cotizacion?.km != null ? (draft.cotizacion.fuente ?? null) : null,
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
 * el B-12?», «el pedido b12 ya está listo»), si es suyo. Los códigos se
 * repiten cada 2.600 pedidos, así que gana el más reciente. Con varios
 * códigos en el mismo mensaje, el primero que exista.
 */
export async function tripFromCodeInText(conversationId: number, text: string): Promise<Trip | null> {
  for (const code of tripCodesInText(text)) {
    const [trip] = await db
      .select()
      .from(schema.trips)
      .where(and(eq(schema.trips.conversationId, conversationId), eq(schema.trips.code, code)))
      .orderBy(desc(schema.trips.createdAt))
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
