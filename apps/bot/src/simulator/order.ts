import { eq } from "drizzle-orm";

import { assignTripTo, db, isRealGpsCourier, quoteByDistance, schema, updateSimulatorConfig } from "@dispatch/shared/db";
import { emptyDelivery } from "@dispatch/shared";

import { notifyAssigned } from "@/bot/notify";
import { createTrip } from "@/db/queries/trips";
import { dispatchNewTrip } from "@/dispatch/engine";

/**
 * Un pedido creado desde el mapa del simulador, sin WhatsApp. Se crea y se
 * despacha igual que uno confirmado por el restaurante: lo que cambia es que no
 * hay chat al que avisarle.
 *
 * Con `courierId`, es el viaje de prueba de una moto real con GPS (issue #42):
 * se le asigna a ella, como si lo hiciera la central, y el algoritmo no lo toca.
 * Recibe los mensajes en su WhatsApp y el GPS marca las llegadas.
 */
export async function createSimulatedOrder(input: { restaurantId: number; lat: number; lng: number; readyInMinutes: number; courierId?: number | null }) {
  if (input.courierId != null && !(await isRealGpsCourier(input.courierId))) return { error: "No es una moto real con GPS" } as const;

  const [restaurant] = await db.select().from(schema.restaurants).where(eq(schema.restaurants.id, input.restaurantId)).limit(1);
  if (!restaurant?.knownPickupLocation) return { error: "Ese restaurante no tiene ubicación" } as const;

  const delivery = { lat: input.lat, lng: input.lng };
  const quote = await quoteByDistance(restaurant.knownPickupLocation, delivery);
  const draft = {
    ...emptyDelivery(),
    direccionEntrega: `Punto del simulador (${input.lat.toFixed(5)}, ${input.lng.toFixed(5)})`,
    direccionUbicada: null,
    ubicacionEntrega: delivery,
    nombreCliente: "Cliente simulado",
    listoEnMinutos: input.readyInMinutes,
    listoDesde: new Date().toISOString(),
  };
  const trip = await createTrip(null, { origenRestaurante: restaurant.name, mensajeOrigen: null }, draft, quote.price ?? 0, null, restaurant);
  await updateSimulatorConfig((c) => ({ trips: [...c.trips, trip.id] }));

  if (input.courierId != null) {
    const assigned = await assignTripTo(trip.id, input.courierId, { byHand: true });
    if (!assigned) return { error: `Se creó el ${trip.code}, pero la moto no está conectada: escríbele «hola» al bot desde su WhatsApp y asígnalo desde Viajes` } as const;
    await notifyAssigned(trip.id);
    return { tripId: trip.id, code: trip.code } as const;
  }

  if (await dispatchNewTrip(trip.id)) await notifyAssigned(trip.id);
  return { tripId: trip.id, code: trip.code } as const;
}
