import {
  decideKnownNumber,
  decideUnknownNumber,
  exactScores,
  looksLikeName,
  normalizeName,
  type NameScores,
  type RestaurantIdentity,
} from "@dispatch/shared";
import { listRestaurants, type Restaurant } from "@dispatch/shared/db";

import { scoreRestaurantName } from "@/services/openai/restaurant-match";

export type Recognition = {
  identity: RestaurantIdentity;
  /** El restaurante de la decisión, si hay uno. */
  restaurant: Restaurant | null;
  /** El nombre que se comparó, ya normalizado, para no volver a compararlo en
   *  este pedido. Null si no hubo qué comparar o si OpenAI falló. */
  reviewed: string | null;
};

/** Primero lo idéntico, que no gasta una llamada; el modelo solo si hace falta. */
async function compare(name: string, candidates: { id: number; name: string }[]): Promise<NameScores | null> {
  const exact = exactScores(name, candidates);
  return exact.size ? exact : scoreRestaurantName(name, candidates);
}

/**
 * Reconoce a quien escribe (la tabla está en `domain/restaurant-identity.ts`).
 * `reviewed` son los nombres ya comparados en este pedido: el modelo repite el
 * nombre en cada mensaje, y comparar de nuevo podría cambiar la respuesta a
 * mitad de un pedido.
 */
export async function recognizeRestaurant(input: {
  byPhone: Restaurant | null;
  saidName: string | null;
  profileName: string | null;
  reviewed: string[];
}): Promise<Recognition> {
  const { byPhone, profileName, reviewed } = input;
  const saidName = input.saidName && looksLikeName(input.saidName) ? input.saidName : null;

  if (byPhone) {
    const said = saidName && !reviewed.includes(normalizeName(saidName)) ? saidName : null;
    if (!said) return { identity: { kind: "known", restaurantId: byPhone.id }, restaurant: byPhone, reviewed: null };
    const scores = await compare(said, [byPhone]);
    return {
      identity: decideKnownNumber(byPhone.id, said, scores ? (scores.get(byPhone.id) ?? 0) : null),
      restaurant: byPhone,
      reviewed: scores ? normalizeName(said) : null,
    };
  }

  // Lo que dice en el mensaje es a propósito; el perfil, solo si no dijo nada.
  const name = saidName ?? profileName;
  if (!name || !looksLikeName(name) || reviewed.includes(normalizeName(name))) {
    return { identity: { kind: "new" }, restaurant: null, reviewed: null };
  }

  const candidates = (await listRestaurants()).filter((r) => r.active);
  const scores = await compare(name, candidates);
  if (!scores) return { identity: { kind: "new" }, restaurant: null, reviewed: null };

  const identity = decideUnknownNumber(scores, candidates);
  const restaurant = identity.kind === "new" ? null : (candidates.find((c) => c.id === identity.restaurantId) ?? null);
  return { identity, restaurant, reviewed: normalizeName(name) };
}
