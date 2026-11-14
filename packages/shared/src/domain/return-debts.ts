import { normalizeName } from "./restaurant-identity";

/**
 * Pendientes de regreso (docs/FLUJO-DOMICILIARIO.md, «Pendientes de regreso»):
 * después de entregar, el domiciliario tiene que volver al restaurante porque
 * se llevó su datáfono o porque le quedó debiendo la comida. Lo declara él al
 * recoger; la agencia no maneja la plata: no hay montos, solo quién, a quién,
 * por qué y desde cuándo.
 *
 * Aquí lo que no depende de la base: qué dice el domiciliario cuando lo
 * escribe, cómo se agrupan y cuándo un datáfono lleva demasiado afuera. Lo
 * usan el bot, el portal y las alertas al celular.
 */

export type ReturnDebtReason = "datafono" | "plata";

export const DEBT_REASON_LABEL: Record<ReturnDebtReason, string> = {
  datafono: "Datáfono",
  plata: "Plata",
};

// ---------------------------------------------------------------------------
// Lo que escribe el domiciliario
// ---------------------------------------------------------------------------

export type DebtText =
  /** «recogí, llevo datáfono», «quedé debiendo en Donde Lucho». `picked`: dijo
   *  también que ya recogió. `restaurant`: el nombre que escribió, si dijo uno. */
  | { kind: "declare"; reason: ReturnDebtReason; picked: boolean; restaurant: string | null }
  /** «ya devolví el datáfono», «ya le pagué a Donde Lucho». */
  | { kind: "close"; reason: ReturnDebtReason; restaurant: string | null };

/** Más largo que esto ya no es una frase corta: puede ser una novedad. */
const MAX_TEXT = 90;

// `\b` de JavaScript no ve las letras con tilde («recogí», «pagué»): estos
// límites de palabra sí.
const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;

const DATAFONO = String.raw`(?:el\s+|la\s+)?(?:dat[aá]fono|m[aá]quina(?:\s+de\s+tarjetas?)?)${E}`;
const DECLARE_DATAFONO = new RegExp(String.raw`${B}(?:llevo|tengo|cargo|me\s+llev[eé]|me\s+traje|me\s+dieron|traigo)\s+${DATAFONO}`, "iu");
const DECLARE_PLATA = new RegExp(
  String.raw`${B}(?:qued[eé]\s+debiendo|quedo\s+debiendo|qued[eé]\s+(?:a\s+)?deber|debo\s+(?:la\s+)?(?:plata|comida|pedido)|le\s+debo|no\s+(?:pude|alcanc[eé]\s+a)\s+pagar|no\s+pagu[eé])${E}`,
  "iu",
);
const CLOSE_DATAFONO = new RegExp(String.raw`${B}(?:devolv[ií]|entregu[eé]|dej[eé])\s+${DATAFONO}`, "iu");
const CLOSE_PLATA = new RegExp(String.raw`${B}(?:ya\s+)?(?:le\s+)?pagu[eé]${E}|${B}ya\s+(?:qued[eé]\s+a\s+paz|cancel[eé])${E}`, "iu");
const NEGATED = new RegExp(String.raw`${B}no\s+(?:llevo|tengo|cargo|me\s+llev[eé]|traigo|qued[eé]|quedo|debo|le\s+debo|devolv[ií]|he)${E}`, "iu");
const PICKED = new RegExp(String.raw`${B}recog[ií]${E}|${B}tengo\s+el\s+pedido${E}`, "iu");

/** «… en Donde Lucho», «… a La Brasa Roja», «… donde Sushi Cali»: el nombre
 *  que viene al final, sin la puntuación ni los emojis. */
function namedRestaurant(text: string, after: RegExp): string | null {
  const match = after.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const named = /^\s*(?:,\s*)?(?:en|a|al|donde|de|para)\s+(?:el\s+restaurante\s+|el\s+local\s+)?(.+)$/iu.exec(rest);
  const name = named?.[1]?.replace(/[\s!.,👍✅🛵🙏💳💵]+$/u, "").trim();
  return name ? name : null;
}

/**
 * Lo que dice un mensaje corto del domiciliario sobre un pendiente. Solo frases
 * claras: «no llevo datáfono» o un mensaje largo no cuentan y siguen a la
 * clasificación de siempre, donde pueden ser una novedad.
 */
export function parseDebtText(raw: string): DebtText | null {
  const text = raw.trim();
  if (!text || text.length > MAX_TEXT || NEGATED.test(text)) return null;
  // Primero cerrar: «devolví el datáfono» también dice «datáfono».
  if (CLOSE_DATAFONO.test(text)) return { kind: "close", reason: "datafono", restaurant: namedRestaurant(text, CLOSE_DATAFONO) };
  if (DECLARE_DATAFONO.test(text)) return { kind: "declare", reason: "datafono", picked: PICKED.test(text), restaurant: namedRestaurant(text, DECLARE_DATAFONO) };
  if (DECLARE_PLATA.test(text)) return { kind: "declare", reason: "plata", picked: PICKED.test(text), restaurant: namedRestaurant(text, DECLARE_PLATA) };
  if (CLOSE_PLATA.test(text)) return { kind: "close", reason: "plata", restaurant: namedRestaurant(text, CLOSE_PLATA) };
  return null;
}

/**
 * Cuál de los restaurantes nombró: el que coincide con lo que escribió, sin
 * tildes ni mayúsculas, en cualquier sentido («Lucho» → «Donde Lucho»). `null`
 * si no coincide ninguno o coinciden varios.
 */
export function matchRestaurant<T extends { name: string }>(written: string, candidates: T[]): T | null {
  const w = normalizeName(written);
  if (w.length < 3) return null;
  const hits = candidates.filter((c) => {
    const n = normalizeName(c.name);
    return n.length > 0 && (n === w || n.includes(w) || w.includes(n));
  });
  const names = new Set(hits.map((h) => normalizeName(h.name)));
  return names.size === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------------------
// Agrupar
// ---------------------------------------------------------------------------

/** Lo mínimo de un pendiente para agruparlo y mostrarlo. */
export type DebtRow = {
  id: number;
  courierId: number;
  restaurantId: number | null;
  restaurantName: string;
  reason: ReturnDebtReason;
  tripId: number | null;
  tripCode: string | null;
  createdAt: Date;
  /** Cuándo se entregó su pedido; nulo si todavía no, o si no tiene pedido. */
  deliveredAt: Date | null;
};

/** Los del mismo domiciliario, restaurante y motivo van juntos. Un restaurante
 *  registrado se reconoce por su id; uno sin registrar, por su nombre. */
export function debtGroupKey(d: Pick<DebtRow, "courierId" | "restaurantId" | "restaurantName" | "reason">): string {
  const place = d.restaurantId !== null ? `r${d.restaurantId}` : `n:${normalizeName(d.restaurantName)}`;
  return `${d.courierId}|${place}|${d.reason}`;
}

export type DebtGroup<D extends DebtRow> = {
  key: string;
  courierId: number;
  restaurantId: number | null;
  restaurantName: string;
  reason: ReturnDebtReason;
  /** El más viejo primero. */
  debts: D[];
  /** Desde cuándo debe: el más viejo. */
  since: Date;
};

/** Agrupa por domiciliario, restaurante y motivo; el grupo más viejo primero. */
export function groupDebts<D extends DebtRow>(rows: D[]): DebtGroup<D>[] {
  const groups = new Map<string, DebtGroup<D>>();
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)) {
    const key = debtGroupKey(row);
    const group = groups.get(key);
    if (group) group.debts.push(row);
    else groups.set(key, { key, courierId: row.courierId, restaurantId: row.restaurantId, restaurantName: row.restaurantName, reason: row.reason, debts: [row], since: row.createdAt });
  }
  return [...groups.values()].sort((a, b) => a.since.getTime() - b.since.getTime());
}

/** «A-07», «A-07 y A-08», «A-07, A-08 y A-09». */
export function joinCodes(codes: (string | null)[]): string {
  const list = codes.filter((c): c is string => !!c);
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} y ${list[list.length - 1]}`;
}

// ---------------------------------------------------------------------------
// El datáfono que lleva demasiado afuera
// ---------------------------------------------------------------------------

export const DEFAULT_DATAFONO_ALERT_MINUTES = 30;

/**
 * Desde cuándo cuenta que el datáfono está afuera: desde que se entregó el
 * pedido (antes lo está usando). Uno registrado sin pedido, desde que se
 * registró. `null` si su pedido todavía no se entrega.
 */
export function datafonoOutSince(d: Pick<DebtRow, "tripId" | "createdAt" | "deliveredAt">): Date | null {
  if (d.deliveredAt) return d.deliveredAt;
  return d.tripId === null ? d.createdAt : null;
}

/** Cuándo avisarle a la central que un datáfono no ha vuelto; `null` si no
 *  aplica (es plata, o el pedido no se ha entregado). */
export function datafonoLateAt(d: Pick<DebtRow, "reason" | "tripId" | "createdAt" | "deliveredAt">, minutes: number): Date | null {
  if (d.reason !== "datafono") return null;
  const since = datafonoOutSince(d);
  return since ? new Date(since.getTime() + minutes * 60_000) : null;
}

// ---------------------------------------------------------------------------
// Lo que le llega al domiciliario
// ---------------------------------------------------------------------------

/** Al entregar, o cuando la central lo pide: qué tiene que hacer. */
export function debtCloseText(reason: ReturnDebtReason, restaurant: string, codes: (string | null)[], { nudge = false } = {}): string {
  const list = joinCodes(codes);
  const of = list ? ` (${list})` : "";
  if (nudge) {
    return reason === "datafono"
      ? `📢 Pasa por ${restaurant} a devolver el datáfono${of}. Cuando lo hagas, toca «Ya lo devolví».`
      : `📢 Pasa por ${restaurant} a pagar lo que quedaste debiendo${of}. Cuando lo hagas, toca «Ya pagué».`;
  }
  return reason === "datafono"
    ? `💳 Devuelve el datáfono en ${restaurant}${of}. Cuando lo hagas, toca «Ya lo devolví».`
    : `💵 Quedó anotado que le debes a ${restaurant}${of}. Cuando le pagues, toca «Ya pagué».`;
}

/** El título del botón que lo cierra (WhatsApp: máximo 20 caracteres). */
export function debtCloseButtonTitle(reason: ReturnDebtReason): string {
  return reason === "datafono" ? "✅ Ya lo devolví" : "✅ Ya pagué";
}

/** La confirmación al cerrarlo él. */
export function debtClosedText(reason: ReturnDebtReason, restaurant: string): string {
  return reason === "datafono" ? `✅ Anotado: devolviste el datáfono en ${restaurant}.` : `✅ Anotado: le pagaste a ${restaurant}.`;
}
