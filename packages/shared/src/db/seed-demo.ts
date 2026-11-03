import { eq, sql } from "drizzle-orm";

import { db, schema } from "./client";
import { saveFareRanges } from "./fares";

/**
 * Deja la base lista para mostrar: `npm run db:seed:demo`.
 *
 * Se puede correr las veces que haga falta (antes de cada demo): borra los
 * viajes y deja la flota coherente — sin motos "en viaje" sin viaje, ni
 * cronómetros de cinco horas. NO toca las conversaciones: los chats reales
 * con restaurantes se conservan.
 *
 * Arranca con historial (entregas de la mañana, para que Arqueo tenga
 * números) y dos motos en la calle. La columna "Por asignar" queda vacía a
 * propósito: lo que entre en la demo entra por WhatsApp, en vivo.
 */

const COURIERS = [
  { name: "Camilo Rodríguez", phone: "573001112233", lat: 3.4516, lng: -76.532 },
  { name: "Laura Gómez", phone: "573002223344", lat: 3.4372, lng: -76.5225 },
  { name: "Andrés Pardo", phone: "573003334455", lat: 3.4205, lng: -76.5405 },
  { name: "Diana Torres", phone: "573004445566", lat: 3.4721, lng: -76.5295 },
  { name: "Jhon Fredy Martínez", phone: "573005556677", lat: 3.4012, lng: -76.5468 },
  { name: "Sebastián Cruz", phone: "573006667788", lat: 3.4583, lng: -76.5172 },
];

/** Restaurante de prueba: el número es el que usa `npm run bot:chat` por
 *  defecto, así el chat de la terminal escribe como un restaurante registrado. */
const DEMO_RESTAURANT = {
  phone: "573000000001",
  name: "Donde Lucho",
  knownPickupAddress: "Cra 83 # 42-15, El Caney",
  knownPickupLocation: { lat: 3.4012, lng: -76.5285 },
};

/** Tabla de precios por distancia (la que se edita en el portal). */
const FARE_RANGES = [
  { upToKm: 2, price: 5000 },
  { upToKm: 4, price: 6000 },
  { upToKm: 6, price: 7000 },
  { upToKm: 8, price: 8000 },
  { upToKm: null, price: 10000 },
];

// Pedidos de ejemplo; `fee` sale de la tabla por km. `courier` es una posición en la flota.
const DELIVERED = [
  { courier: 0, restaurant: "Donde Lucho · Cra 83 El Caney", address: "Calle 48 #98-20, Valle del Lili", fee: 6000, value: 32000, cash: true, hoursAgo: 4.2 },
  { courier: 1, restaurant: "Crepes Express · Pance", address: "Cra 105 #14-30, Ciudad Jardín", fee: 6000, value: 58000, cash: false, hoursAgo: 3.6 },
  { courier: 2, restaurant: "Wok to Go · Valle del Lili", address: "Cra 98 #45-10, Ciudad Bochalema", fee: 8000, value: 41000, cash: true, hoursAgo: 3.1 },
  { courier: 0, restaurant: "La Hamburguesería · El Caney", address: "Calle 42 #83-15, El Caney", fee: 5000, value: 27000, cash: true, hoursAgo: 2.4 },
  { courier: 3, restaurant: "Pizza Nostra · Ciudad Jardín", address: "Cra 122 #18-40, Pance", fee: 6000, value: 46000, cash: false, hoursAgo: 1.8 },
  { courier: 1, restaurant: "Donde Lucho · Cra 83 El Caney", address: "Calle 25 #119-35, Pance", fee: 8000, value: 35000, cash: true, hoursAgo: 1.1 },
];

const EN_ROUTE = [
  { courier: 2, restaurant: "Crepes Express · Pance", address: "Calle 36 #98-12, Valle del Lili", fee: 7500, value: 52000, cash: false, minutesAgo: 9 },
  { courier: 3, restaurant: "Wok to Go · Valle del Lili", address: "Calle 50 #83-22, El Caney", fee: 6000, value: 29000, cash: true, minutesAgo: 4 },
];

function code() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let c = "";
  for (let i = 0; i < 5; i++) c += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `D-${c}`;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

export async function seedDemo() {
  await db.delete(schema.dispatchOffers);
  await db.delete(schema.assignments);
  await db.delete(schema.trips);
  // Los chats se quedan, pero sin un pedido a medio armar ni un asesor pendiente.
  // Lo ya conversado se da por respondido, para que el bot no lo retome.
  await db.update(schema.conversations).set({
    draft: null,
    failedAttempts: 0,
    botPaused: false,
    escalationReason: null,
    processedThroughMessageId: sql`(select max(${schema.messages.id}) from ${schema.messages} where ${schema.messages.conversationId} = ${schema.conversations.id})`,
  });

  await saveFareRanges(FARE_RANGES);

  await db
    .insert(schema.restaurants)
    .values(DEMO_RESTAURANT)
    .onConflictDoUpdate({ target: schema.restaurants.phone, set: DEMO_RESTAURANT });

  // Flota: se respeta la que haya (los celulares reales que el equipo agregó
  // en Flota). Solo si está vacía se crean los motorizados de ejemplo.
  let fleet = await db.select().from(schema.couriers).where(eq(schema.couriers.active, true));
  if (fleet.length === 0) {
    fleet = await db
      .insert(schema.couriers)
      .values(COURIERS.map((c) => ({ ...c, status: "available" as const, locationUpdatedAt: new Date() })))
      .returning();
  }
  fleet.sort((a, b) => a.id - b.id);
  const ids = fleet.map((c) => c.id);
  for (const id of ids) {
    await db
      .update(schema.couriers)
      .set({ status: "available", lastAssignedAt: null, deliveriesThisShift: 0, shiftStartedAt: ago(5 * 60) })
      .where(eq(schema.couriers.id, id));
  }
  // Los viajes "en ruta" de ejemplo solo van a motorizados de ejemplo: a un
  // celular real no se le puede dejar un viaje inventado que nunca le llegó.
  const demoPhones = new Set(COURIERS.map((c) => c.phone));
  const fakeIds = fleet.filter((c) => demoPhones.has(c.phone)).map((c) => c.id);

  const delivered = new Map<number, number>();
  const lastAt = new Map<number, Date>();

  async function addTrip(
    t: { restaurant: string; address: string; fee: number; value: number; cash: boolean },
    courierId: number,
    createdAt: Date,
    assignedAt: Date,
    deliveredAt: Date | null,
  ) {
    const courierName = fleet.find((c) => c.id === courierId)!.name;
    const [trip] = await db
      .insert(schema.trips)
      .values({
        code: code(),
        status: deliveredAt ? "delivered" : "en_route",
        originRestaurantName: t.restaurant,
        deliveryAddress: t.address,
        customerPhone: `31${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        valueToCollect: t.value,
        paymentMethod: t.cash ? "efectivo" : "transferencia",
        requiresCashReturn: t.cash,
        deliveryFee: t.fee,
        createdAt,
        updatedAt: deliveredAt ?? assignedAt,
      })
      .returning();
    await db.insert(schema.assignments).values({
      tripId: trip.id,
      courierId,
      courierName,
      assignedAt,
      dispatchedAt: assignedAt,
      deliveredAt,
    });
    delivered.set(courierId, (delivered.get(courierId) ?? 0) + 1);
    if (!lastAt.has(courierId) || lastAt.get(courierId)! < assignedAt) lastAt.set(courierId, assignedAt);
  }

  for (const t of DELIVERED) {
    const created = ago(t.hoursAgo * 60);
    await addTrip(t, ids[t.courier % ids.length], created, new Date(created.getTime() + 40_000), new Date(created.getTime() + 24 * 60_000));
  }
  const enRoute = EN_ROUTE.slice(0, fakeIds.length).map((t, i) => ({ ...t, courierId: fakeIds[(fakeIds.length - 1 - i) % fakeIds.length] }));
  for (const t of enRoute) {
    const assigned = ago(t.minutesAgo);
    await addTrip(t, t.courierId, new Date(assigned.getTime() - 30_000), assigned, null);
  }

  // Contadores y turnos coherentes con el historial recién creado.
  for (const id of ids) {
    await db
      .update(schema.couriers)
      .set({ deliveriesThisShift: delivered.get(id) ?? 0, lastAssignedAt: lastAt.get(id) ?? null })
      .where(eq(schema.couriers.id, id));
  }
  for (const t of enRoute) {
    await db.update(schema.couriers).set({ status: "busy" }).where(eq(schema.couriers.id, t.courierId));
  }

  console.log(`✓ Restaurante de prueba: ${DEMO_RESTAURANT.name} (${DEMO_RESTAURANT.phone})`);
  console.log(`✓ Tarifas: ${FARE_RANGES.length} rangos por km`);
  console.log(`✓ Flota: ${ids.length} motorizados (${ids.length - enRoute.length} libres, ${ids.length - fakeIds.length} con celular real)`);
  console.log(`✓ Viajes: ${DELIVERED.length} entregados, ${enRoute.length} en ruta, 0 por asignar`);
}
