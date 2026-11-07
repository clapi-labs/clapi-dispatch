import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";

import { inServiceArea } from "../domain/coordinates";
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

/** Lo que llega del formulario de restaurantes del portal, ya revisado. */
export type RestaurantInput = {
  name: string;
  phone: string | null;
  pickupAddress: string;
  pickupDetail: string | null;
  pickupLocation: { lat: number; lng: number };
  active: boolean;
};

/**
 * Revisa el cuerpo del formulario. Sin coordenadas dentro del área de
 * servicio no se guarda: la recogida de un restaurante registrado es la que
 * usa el bot para cobrar, y un punto equivocado cobra mal cada pedido.
 */
export function validateRestaurant(body: unknown): { input: RestaurantInput } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Datos inválidos" };
  const b = body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const name = text(b.name);
  const phone = normalizePhone(text(b.phone));
  const pickupAddress = text(b.pickupAddress);
  const pickupDetail = text(b.pickupDetail) || null;
  const loc = b.pickupLocation as { lat?: unknown; lng?: unknown } | null;
  const lat = Number(loc?.lat);
  const lng = Number(loc?.lng);

  if (!name) return { error: "Falta el nombre" };
  if (phone && phone.length < 10) return { error: "El WhatsApp debe tener al menos 10 dígitos" };
  if (!pickupAddress) return { error: "Falta la dirección" };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: "Faltan las coordenadas" };
  if (!inServiceArea({ lat, lng })) return { error: "Las coordenadas quedan fuera de Cali y Jamundí" };

  return {
    input: {
      name,
      // "3001234567" se guarda como "573001234567", igual que el wa_id de WhatsApp.
      phone: !phone ? null : phone.length === 10 ? `57${phone}` : phone,
      pickupAddress,
      pickupDetail,
      pickupLocation: { lat, lng },
      active: b.active !== false,
    },
  };
}

/** Todos, activos e inactivos, por nombre. */
export async function listRestaurants(): Promise<Restaurant[]> {
  return db.select().from(restaurants).orderBy(asc(restaurants.name));
}

/** Otro restaurante (activo o no) con el mismo número, para no duplicarlo. */
async function phoneTaken(phone: string, exceptId: number | null) {
  const last10 = normalizePhone(phone).slice(-10);
  const conditions = [sql`right(regexp_replace(${restaurants.phone}, '\\D', '', 'g'), 10) = ${last10}`];
  if (exceptId !== null) conditions.push(ne(restaurants.id, exceptId));
  const [row] = await db.select({ name: restaurants.name }).from(restaurants).where(and(...conditions)).limit(1);
  return row?.name ?? null;
}

function rowValues(input: RestaurantInput) {
  return {
    name: input.name,
    phone: input.phone,
    knownPickupAddress: input.pickupAddress,
    knownPickupLocation: input.pickupLocation,
    pickupDetail: input.pickupDetail,
    active: input.active,
  };
}

export async function createRestaurant(input: RestaurantInput): Promise<{ restaurant: Restaurant } | { error: string }> {
  const taken = input.phone && (await phoneTaken(input.phone, null));
  if (taken) return { error: `Ese número ya es de ${taken}` };
  const [restaurant] = await db.insert(restaurants).values(rowValues(input)).returning();
  return { restaurant };
}

export async function updateRestaurant(
  id: number,
  input: RestaurantInput,
): Promise<{ restaurant: Restaurant } | { error: string } | null> {
  const taken = input.phone && (await phoneTaken(input.phone, id));
  if (taken) return { error: `Ese número ya es de ${taken}` };
  const [restaurant] = await db.update(restaurants).set(rowValues(input)).where(eq(restaurants.id, id)).returning();
  return restaurant ? { restaurant } : null;
}

export async function setRestaurantPhoto(id: number, photo: string | null) {
  const [restaurant] = await db.update(restaurants).set({ photo }).where(eq(restaurants.id, id)).returning();
  return restaurant ?? null;
}

/** Sus viajes se conservan: guardan el nombre y quedan sin el enlace al restaurante. */
export async function deleteRestaurant(id: number) {
  const [restaurant] = await db.delete(restaurants).where(eq(restaurants.id, id)).returning();
  return restaurant ?? null;
}

/** Para comparar nombres: sin mayúsculas, tildes ni espacios de más. */
export function normalizeName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

/** Más corto que esto, un nombre aparece por casualidad en cualquier mensaje. */
const MIN_NAME_LENGTH = 4;

/**
 * Los restaurantes activos que el texto nombra, como palabras completas. Si un
 * nombre está dentro de otro («Pizza» y «Pizza Nona»), queda el más largo.
 */
export async function restaurantsNamedIn(text: string): Promise<Restaurant[]> {
  const haystack = ` ${normalizeName(text)} `;
  const all = await db.select().from(restaurants).where(eq(restaurants.active, true));
  const named = all.filter((r) => {
    const name = normalizeName(r.name);
    return name.length >= MIN_NAME_LENGTH && haystack.includes(` ${name} `);
  });
  return named.filter((r) => !named.some((o) => o.id !== r.id && normalizeName(o.name).includes(normalizeName(r.name)) && o.name.length > r.name.length));
}

/** Los restaurantes activos que se llaman exactamente así (el perfil de WhatsApp). */
export async function restaurantsNamed(name: string): Promise<Restaurant[]> {
  const wanted = normalizeName(name);
  if (wanted.length < MIN_NAME_LENGTH) return [];
  const all = await db.select().from(restaurants).where(eq(restaurants.active, true));
  return all.filter((r) => normalizeName(r.name) === wanted);
}

/** Le guarda el número a un restaurante que no tenía, solo si sigue sin uno. */
export async function claimRestaurantPhone(id: number, phone: string): Promise<Restaurant | null> {
  const [restaurant] = await db
    .update(restaurants)
    .set({ phone: normalizePhone(phone) })
    .where(and(eq(restaurants.id, id), isNull(restaurants.phone)))
    .returning();
  return restaurant ?? null;
}
