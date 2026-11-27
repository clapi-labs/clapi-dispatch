/**
 * Encargos (docs/INTERVENCION-MANUAL.md, «Encargos»): el restaurante pide que le
 * compren o le traigan algo. El bot lo reconoce y pasa el chat a la central
 * (domain/errand.ts); la central lo acuerda en la conversación y, desde el panel
 * «Encargo», lo crea como viaje con su precio o decide no crearlo. En los dos
 * casos el chat vuelve al bot: no puede quedar pausado después de decidir.
 *
 * El sistema no verifica nada del encargo (ni zona, ni precio, ni la tienda):
 * guarda lo que pidió el restaurante y el precio que puso la central. Se entrega
 * en el mismo restaurante, y solo la central lo asigna.
 */
import { and, eq, like } from "drizzle-orm";

import { ERRAND_REASON_PREFIX, errandRequest } from "../domain/errand";
import { db } from "./client";
import { findRestaurantByPhone } from "./restaurants";
import { conversations, trips } from "./schema";
import { nextTripCode } from "./trip-code";

type Trip = typeof trips.$inferSelect;

/** Lo que devuelve el chat al bot: igual que «Devolver al bot». */
const RESUMED = { botPaused: false, escalationReason: null, draft: null, failedAttempts: 0 } as const;

/** El chat sigue pausado por un encargo: el único estado desde el que se decide. */
const waitingErrand = (conversationId: number) =>
  and(eq(conversations.id, conversationId), eq(conversations.botPaused, true), like(conversations.escalationReason, `${ERRAND_REASON_PREFIX}%`));

/**
 * Devuelve el chat al bot si seguía esperando la decisión de un encargo, y el
 * motivo que tenía. Es el «reclamo» del chat: con dos clics seguidos (o dos
 * personas a la vez) solo uno gana, y no se crean dos encargos.
 */
async function claimErrandChat(conversationId: number) {
  const [claimed] = await db
    .update(conversations)
    .set(RESUMED)
    .where(waitingErrand(conversationId))
    .returning({ phone: conversations.phone, displayName: conversations.displayName });
  return claimed ?? null;
}

export type ErrandDecision<T> = { ok: true; value: T } | { ok: false; reason: "not_errand" };

/**
 * «Crear encargo»: el viaje queda pendiente, con código de la misma serie, el
 * precio de la central y lo que pidió el restaurante, para entregar en el mismo
 * restaurante. El chat vuelve al bot. `not_errand` si el chat ya no esperaba
 * un encargo (otro lo decidió, o lo devolvieron al bot).
 */
export async function createErrandTrip(conversationId: number, price: number): Promise<ErrandDecision<Trip>> {
  // Lo que pidió se lee antes de soltar el chat: el reclamo borra el motivo.
  const [before] = await db.select({ reason: conversations.escalationReason }).from(conversations).where(waitingErrand(conversationId));
  if (!before) return { ok: false, reason: "not_errand" };
  const chat = await claimErrandChat(conversationId);
  if (!chat) return { ok: false, reason: "not_errand" };

  const restaurant = await findRestaurantByPhone(chat.phone);
  const name = restaurant?.name ?? chat.displayName?.trim() ?? chat.phone;
  const address = restaurant?.knownPickupAddress ? [restaurant.knownPickupAddress, restaurant.pickupDetail].filter(Boolean).join(", ") : null;
  const [trip] = await db
    .insert(trips)
    .values({
      code: await nextTripCode(),
      kind: "errand",
      status: "pending",
      conversationId,
      restaurantId: restaurant?.id ?? null,
      originRestaurantName: name,
      // La tienda no se sabe (la acuerda la central): no hay recogida.
      pickupAddress: null,
      pickupLocation: null,
      // Se entrega en el mismo restaurante. Sin dirección registrada, su nombre:
      // la central completa lo que haga falta por el chat del domiciliario.
      deliveryAddress: address ?? name,
      deliveryLocation: restaurant?.knownPickupLocation ?? null,
      notes: errandRequest(before.reason) ?? "Ver el chat del restaurante",
      deliveryFee: Math.max(0, Math.round(price)),
    })
    .returning();
  return { ok: true, value: trip };
}

/** «No crear»: el chat vuelve al bot y no se crea nada. La central ya le dijo
 *  al restaurante lo que fuera, así que nadie le escribe. */
export async function dismissErrand(conversationId: number): Promise<ErrandDecision<null>> {
  return (await claimErrandChat(conversationId)) ? { ok: true, value: null } : { ok: false, reason: "not_errand" };
}
