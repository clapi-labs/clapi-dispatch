/**
 * Quién escribe: el restaurante se reconoce por su número y por su nombre. El
 * nombre es el que dice en el mensaje o, si no dice ninguno, el de su perfil
 * de WhatsApp. Aquí solo se decide, sin base ni red: quién compara los nombres
 * y qué se hace con la decisión está en `apps/bot/src/bot/restaurant-identity.ts`.
 *
 * | Número        | Nombre                                 | Decisión     |
 * | Registrado    | Coincide, no viene o solo es el perfil | `known`      |
 * | Registrado    | Dice ser otro                          | `confirm`    |
 * | No registrado | Uno claro, sin número                  | `link`       |
 * | No registrado | Uno claro, con otro número             | `other-number` |
 * | No registrado | Varios parecidos, ninguno o no viene   | `new`        |
 */

/** Desde este puntaje (0 a 1) dos nombres son el mismo restaurante. Alto a
 *  propósito: equivocarse manda la moto a recoger a otro lado. */
export const NAME_MATCH_THRESHOLD = 0.85;

/** El mejor debe sacarle esta ventaja al segundo: con «Pizza Nona Norte» y
 *  «Pizza Nona Sur» registrados, «Pizza Nona» no dice cuál de los dos es. */
export const NAME_MATCH_MARGIN = 0.15;

/** Con una palabra que distingue de más o de menos («El Paisa Express» y
 *  «El Paisa»), el puntaje no llega al umbral, diga lo que diga el modelo. */
const DISTINCT_WORDS_CAP = 0.8;

export type RestaurantCandidate = { id: number; name: string; phone: string | null };

/** Puntaje por id de restaurante. El que no aparece no se parece en nada. */
export type NameScores = Map<number, number>;

export type RestaurantIdentity =
  | { kind: "known"; restaurantId: number }
  | { kind: "confirm"; restaurantId: number }
  | { kind: "link"; restaurantId: number }
  | { kind: "other-number"; restaurantId: number }
  | { kind: "new" };

/** Sin mayúsculas, tildes, signos ni espacios de más: «Piccolo's  Café» = «piccolos cafe». */
export function normalizeName(name: string) {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Un nombre de negocio no da para tanto: lo que pase de aquí es una frase, y
 *  no se le manda al modelo como si fuera un nombre. */
const MAX_NAME_LENGTH = 60;

export function looksLikeName(name: string) {
  const normalized = normalizeName(name);
  return normalized.length > 0 && name.trim().length <= MAX_NAME_LENGTH;
}

/**
 * El nombre va en el mensaje como destino o referencia («domi para Pizza Nona»,
 * «al lado de Pizza Nona»), no como quien escribe. El modelo a veces lo lee como
 * identificación, y de eso sale un número guardado: aquí no se le deja al azar.
 */
export function namedAsDestination(text: string, name: string) {
  const wanted = normalizeName(name);
  if (!wanted) return false;
  return new RegExp(`(?:^|\\s)(?:a|para|hacia|hasta|lado de|frente de|cerca de|junto a)\\s+(?:(?:el|la|los|las)\\s+)?${wanted}(?:\\s|$)`, "u").test(normalizeName(text));
}

/** Palabras que no distinguen a un negocio de otro: artículos, el tipo de
 *  negocio y la ciudad. */
const GENERIC_WORDS = new Set(["la", "el", "los", "las", "de", "del", "y", "restaurante", "pizza", "pizzas", "pizzeria", "asadero", "cafe", "empanadas", "cali", "jamundi"]);

/** El nombre sin el orden ni lo genérico: «La Nona Pizzería» = «Pizzería La Nona». */
function nameKey(name: string) {
  return normalizeName(name)
    .split(" ")
    .filter((word) => !GENERIC_WORDS.has(word))
    .sort()
    .join(" ");
}

/** Lo que se compara sin gastar una llamada al modelo: el mismo nombre, escrito
 *  en otro orden o con una palabra genérica de más o de menos. */
export function exactScores(name: string, candidates: Pick<RestaurantCandidate, "id" | "name">[]): NameScores {
  const wanted = nameKey(name);
  return new Map(candidates.filter((c) => wanted && nameKey(c.name) === wanted).map((c) => [c.id, 1]));
}

/**
 * La respuesta del modelo, validada: solo ids que se le mandaron y puntajes
 * entre 0 y 1, con el tope si hay palabras distintas. Lo demás se descarta,
 * porque de aquí sale a dónde va la moto.
 */
export function parseNameScores(raw: unknown, validIds: number[]): NameScores {
  const scores: NameScores = new Map();
  const list = (raw as { coincidencias?: unknown } | null)?.coincidencias;
  if (!Array.isArray(list)) return scores;
  for (const item of list) {
    const { id, puntaje, palabrasDistintas } = (item ?? {}) as { id?: unknown; puntaje?: unknown; palabrasDistintas?: unknown };
    if (typeof id !== "number" || !validIds.includes(id)) continue;
    if (typeof puntaje !== "number" || puntaje < 0 || puntaje > 1) continue;
    const score = Array.isArray(palabrasDistintas) && palabrasDistintas.length ? Math.min(puntaje, DISTINCT_WORDS_CAP) : puntaje;
    scores.set(id, Math.max(score, scores.get(id) ?? 0));
  }
  return scores;
}

/**
 * Un número registrado ya dice quién es. Solo lo que el restaurante dice en el
 * mensaje se revisa: el perfil de WhatsApp suele ser personal y no cuenta como
 * conflicto. `ownScore` null = no se pudo comparar: gana el número.
 */
export function decideKnownNumber(restaurantId: number, saidName: string | null, ownScore: number | null): RestaurantIdentity {
  if (!saidName || ownScore === null || ownScore >= NAME_MATCH_THRESHOLD) return { kind: "known", restaurantId };
  return { kind: "confirm", restaurantId };
}

/** Un número sin registrar: lo reconoce solo un nombre claro y sin rival. */
export function decideUnknownNumber(scores: NameScores, candidates: RestaurantCandidate[]): RestaurantIdentity {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scores.get(candidate.id) ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (!best || best.score < NAME_MATCH_THRESHOLD) return { kind: "new" };
  if (second && best.score - second.score < NAME_MATCH_MARGIN) return { kind: "new" };
  return best.candidate.phone ? { kind: "other-number", restaurantId: best.candidate.id } : { kind: "link", restaurantId: best.candidate.id };
}
