import { and, eq, sql } from "drizzle-orm";

import { db } from "./client";
import { restaurants } from "./schema";

export type Restaurant = typeof restaurants.$inferSelect;

/** Solo los dígitos: "+57 300 123 4567" y "573001234567" son el mismo número. */
export function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

/**
 * El restaurante que escribe, por su número. Compara los últimos 10 dígitos,
 * igual que con los motorizados: "3001234567" guardado a mano y el wa_id
 * "573001234567" que manda WhatsApp son la misma persona.
 */
export async function findRestaurantByPhone(phone: string): Promise<Restaurant | null> {
  const last10 = normalizePhone(phone).slice(-10);
  const [row] = await db
    .select()
    .from(restaurants)
    .where(and(eq(restaurants.active, true), sql`right(regexp_replace(${restaurants.phone}, '\\D', '', 'g'), 10) = ${last10}`))
    .limit(1);
  return row ?? null;
}

/**
 * Registra un restaurante, o lo actualiza si el número ya existe. La
 * ubicación se guarda una sola vez aquí: cada pedido la reutiliza sin volver
 * a geocodificar.
 */
export async function saveRestaurant(input: {
  phone: string;
  name: string;
  pickupAddress: string;
  pickupLocation: { lat: number; lng: number } | null;
}): Promise<{ restaurant: Restaurant; created: boolean }> {
  const values = {
    name: input.name,
    knownPickupAddress: input.pickupAddress,
    knownPickupLocation: input.pickupLocation,
    active: true,
  };

  const existing = await findRestaurantByPhone(input.phone);
  if (existing) {
    const [restaurant] = await db.update(restaurants).set(values).where(eq(restaurants.id, existing.id)).returning();
    return { restaurant, created: false };
  }

  const [restaurant] = await db
    .insert(restaurants)
    .values({ ...values, phone: normalizePhone(input.phone) })
    .returning();
  return { restaurant, created: true };
}
