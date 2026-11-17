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

/** Minutos antes de la hora límite del restaurante en que se recuerda pasar a
 *  devolver el datáfono o a pagar (`settings.bot_config.closingDebtMinutes`). */
export const DEFAULT_CLOSING_DEBT_MINUTES = 30;

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

// ---------------------------------------------------------------------------
// El reclamo del restaurante (#61)
// ---------------------------------------------------------------------------

/**
 * Lo que reclama el restaurante cuando pide su plata o su datáfono, o avisa que
 * ya va a cerrar (`docs/BOT.md`, «Reclamos de datáfono o plata»). `reason`:
 * `null` cuando dice que va a cerrar o pide cuadrar sin especificar cuál.
 */
export type DebtClaim = {
  reason: ReturnDebtReason | null;
  closing: boolean;
};

const CLOSING_RE = new RegExp(
  String.raw`${B}(?:(?:ya\s+)?vamos\s+a\s+cerrar|estamos\s+(?:por\s+|a\s+punto\s+de\s+)?cerrar|estamos\s+cerrando|ya\s+(?:casi\s+)?cerramos|vamos\s+cerrando|cerramos\s+(?:ya|pronto|en\s+\d+)|antes\s+de\s+(?:que\s+)?(?:cerremos|cerrar))${E}`,
  "iu",
);

const CLAIM_VERB = String.raw`(?:a\s+qu[eé]\s+hora|cu[aá]ndo|qui[eé]n|qu[eé]\s+pas[oó]\s+con|c[oó]mo\s+vamos\s+con|necesit(?:o|amos)|urge|m[aá]nd(?:a|e|en)(?:me)?|env[ií](?:a|e|en)(?:me)?|tr[aá](?:e|iga|igan)(?:me)?|devu[eé]lv(?:a|an|eme)|p[aá]s(?:a|e|en)(?:\s+a)?|veng(?:a|an)(?:\s+a)?|reclam(?:o|ar)|no\s+(?:me\s+|nos\s+)?han?\s+(?:tra[ií]do|devuelto|entregado|venido|pagado|cancelado)|no\s+ha\s+(?:vuelto|llegado|tra[ií]do)|faltan?\s+(?:traer|pagar|entregar|devolver))`;

const CLAIM_DATAFONO_RE = new RegExp(
  String.raw`${B}(?:` +
    String.raw`${CLAIM_VERB}\s+(?:(?:traer|devolver|entregar|dejar|mandar|enviar|pasar\s+por|por)\s+)?(?:el\s+|mi\s+|nuestro\s+)?(?:dat[aá]fono|m[aá]quina(?:\s+de\s+tarjetas?)?)` +
    String.raw`|(?:a\s+qu[eé]\s+hora|cu[aá]ndo|qui[eé]n\s+(?:tiene|se\s+llev[oó])|d[oó]nde\s+(?:est[aá]|va)|qu[eé]\s+pas[oó]\s+con)\s+[^.!?\n]{0,35}?(?:el\s+|mi\s+|nuestro\s+)?dat[aá]fono` +
    String.raw`|(?:se\s+llev(?:o|ó|aron)|qued(?:o|ó|aron)\s+con)\s+(?:el\s+|mi\s+|nuestro\s+)?dat[aá]fono` +
    String.raw`|(?:el\s+|mi\s+|nuestro\s+)dat[aá]fono\s+(?:no\s+ha\s+(?:llegado|vuelto)|no\s+(?:me\s+)?lo\s+han\s+(?:tra[ií]do|devuelto))` +
    String.raw`)${E}`,
  "iu",
);

const CLAIM_PLATA_RE = new RegExp(
  String.raw`${B}(?:` +
    String.raw`${CLAIM_VERB}\s+[^.!?\n]{0,35}?(?:(?:la|mi|nuestra)\s+plata|el\s+efectivo|lo\s+del?\s+efectivo|lo\s+que\s+(?:me\s+|nos\s+)?debe[ns]?|pagar(?:me|nos)?|cuadrar)` +
    String.raw`|(?:a\s+qu[eé]\s+hora|cu[aá]ndo|qui[eé]n)\s+(?:me\s+|nos\s+)?(?:trae[nr]?|vienen?\s+a\s+(?:pagar|traer|dejar)|pasan?\s+a\s+(?:pagar|dejar)|pagan?|devuelven?)\s+[^.!?\n]{0,30}?(?:plata|efectivo|pedidos?|domicilios?|lo\s+de\s+hoy)` +
    String.raw`|(?:me\s+|nos\s+)?(?:qued(?:o|ó|aron)\s+debiendo|debe[ns]\s+(?:la\s+plata|el\s+efectivo|un(?:os)?\s+(?:pedido|domicilio)|lo\s+de\s+hoy))` +
    String.raw`|(?:la|mi|nuestra)\s+plata\s+(?:de\s+(?:los\s+pedidos|los\s+domicilios|hoy)|que\s+(?:me\s+|nos\s+)?debe[ns]?)` +
    String.raw`)${E}`,
  "iu",
);

const CLOSING_PLATA_RE = new RegExp(String.raw`${B}(?:plata|efectivo|pagar|paguen|pague|debe[ns]?|cuadrar)${E}`, "iu");
const CLOSING_DATAFONO_RE = new RegExp(String.raw`${B}(?:dat[aá]fono|m[aá]quina)${E}`, "iu");

/**
 * Reconoce si el restaurante está reclamando su plata o su datáfono, o avisando
 * que ya va a cerrar. No confunde un pedido normal («llevar datáfono», «cobra
 * 30.000 en efectivo») ni una consulta de estado («¿ya va la moto?»).
 */
export function parseDebtClaim(raw: string): DebtClaim | null {
  const text = raw.trim();
  if (!text) return null;
  const closing = CLOSING_RE.test(text);
  const asksDatafono = CLAIM_DATAFONO_RE.test(text) || (closing && CLOSING_DATAFONO_RE.test(text));
  const asksPlata = CLAIM_PLATA_RE.test(text) || (closing && CLOSING_PLATA_RE.test(text));
  if (!closing && !asksDatafono && !asksPlata) return null;
  const reason: ReturnDebtReason | null = asksDatafono && !asksPlata ? "datafono" : asksPlata && !asksDatafono ? "plata" : null;
  return { reason, closing };
}

/** Combina lo que leyó el modelo con la detección determinista en código. */
export function mergeDebtClaim(fromModel: DebtClaim | null | undefined, fromText: DebtClaim | null): DebtClaim | null {
  if (!fromModel && !fromText) return null;
  if (!fromModel) return fromText;
  if (!fromText) return fromModel;
  return {
    reason: fromText.reason ?? fromModel.reason,
    closing: fromText.closing || fromModel.closing,
  };
}

/** Lo que se sabe de cada grupo abierto de ese restaurante para decidir qué hacer. */
export type ClaimGroupCandidate = {
  courierId: number;
  courierName: string;
  reason: ReturnDebtReason;
  since: Date;
  /** Si ya se le avisó al domiciliario por un reclamo anterior. */
  claimedAt: Date | null;
  /** Conectado en Flota (`active && status !== "offline"`). */
  connected: boolean;
  /** Lleva pedidos abiertos ahora mismo. */
  busy: boolean;
};

export type ClaimDecision =
  | { kind: "auto"; courierId: number; courierName: string; busy: boolean }
  | { kind: "central"; why: string };

/**
 * Caso claro vs. pasar a la central (#61):
 * - Claro: un solo domiciliario tiene pendientes que coinciden, está conectado,
 *   no se le había avisado ya por un reclamo, y puede ir (demanda baja, o está
 *   libre, o el restaurante dijo que va a cerrar).
 * - Cualquier otro caso va a la central con el motivo.
 */
export function decideDebtClaim(
  claim: DebtClaim,
  groups: ClaimGroupCandidate[],
  demand: "alta" | "baja",
): ClaimDecision {
  const matching = claim.reason ? groups.filter((g) => g.reason === claim.reason) : groups;
  if (!matching.length) {
    const what = claim.reason === "datafono" ? "ningún datáfono pendiente registrado" : claim.reason === "plata" ? "plata pendiente registrada" : "ningún pendiente registrado";
    return { kind: "central", why: `No hay ${what} (el domiciliario no lo declaró).` };
  }
  const byCourier = new Map<number, ClaimGroupCandidate[]>();
  for (const g of matching) {
    const list = byCourier.get(g.courierId) ?? [];
    list.push(g);
    byCourier.set(g.courierId, list);
  }
  if (byCourier.size > 1) {
    const names = joinCodes([...byCourier.values()].map((list) => list[0].courierName));
    return { kind: "central", why: `Le deben varios domiciliarios (${names}).` };
  }
  const [courierGroups] = [...byCourier.values()];
  const courier = courierGroups[0];
  if (courierGroups.some((g) => g.claimedAt !== null)) {
    return { kind: "central", why: `Ya se le había avisado a ${courier.courierName} y el restaurante volvió a reclamar.` };
  }
  if (!courier.connected) {
    return { kind: "central", why: `${courier.courierName} está desconectado.` };
  }
  const canGo = demand === "baja" || !courier.busy || claim.closing;
  if (!canGo) {
    return { kind: "central", why: `${courier.courierName} está ocupado con demanda alta.` };
  }
  return { kind: "auto", courierId: courier.courierId, courierName: courier.courierName, busy: courier.busy };
}

/** Lo que le llega al domiciliario cuando el restaurante reclama en el caso claro. */
export function debtClaimCourierText(
  reason: ReturnDebtReason,
  restaurant: string,
  codes: (string | null)[],
  { closing = false, busy = false }: { closing?: boolean; busy?: boolean } = {},
): string {
  const list = joinCodes(codes);
  const of = list ? ` (${list})` : "";
  const closingNote = closing ? " (van a cerrar)" : "";
  const what = reason === "datafono" ? "su datáfono" : "su plata";
  const button = reason === "datafono" ? "«Ya lo devolví»" : "«Ya pagué»";
  const when = busy ? "Pasa apenas entregues lo que llevas" : reason === "datafono" ? "Pasa por allá a devolverlo" : "Pasa por allá a pagar";
  return `📢 ${restaurant} necesita ${what}${of}${closingNote}. ${when}. Cuando lo hagas, toca ${button}.`;
}

/** Lo que le llega al domiciliario unos minutos antes de la hora límite del restaurante. */
export function debtClosingSoonText(
  reason: ReturnDebtReason,
  restaurant: string,
  codes: (string | null)[],
  { busy = false }: { busy?: boolean } = {},
): string {
  const list = joinCodes(codes);
  const of = list ? ` (${list})` : "";
  const action = reason === "datafono" ? "devolver el datáfono" : "pagar lo que quedaste debiendo";
  const button = reason === "datafono" ? "«Ya lo devolví»" : "«Ya pagué»";
  const step = busy ? `pasa apenas entregues lo que llevas a ${action}` : `pasa a ${action}`;
  return `⏰ ${restaurant} cierra pronto: ${step}${of}. Cuando lo hagas, toca ${button}.`;
}

/** Lo que el bot le responde al restaurante cuando reclama. */
export function debtClaimRestaurantText(decision: { kind: "auto"; courierName: string } | { kind: "central" }): string {
  return decision.kind === "auto"
    ? `Ya le avisamos a ${decision.courierName}, va para allá 🛵`
    : "La central ya lo está gestionando 🙏";
}
