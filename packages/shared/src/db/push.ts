import { and, desc, eq, gt, inArray, lt, notInArray, sql } from "drizzle-orm";
import { generateVAPIDKeys, sendNotification, WebPushError } from "web-push";

import {
  ALERT_TTL_S,
  CHAT_HELP_COOLDOWN_MIN,
  chatHelpMessage,
  courierEmergencyMessage,
  customerNoAnswerMessage,
  datafonoClosingMessage,
  datafonoLateMessage,
  debtClaimMessage,
  deliveryStalledMessage,
  isFresh,
  pickupLateMessage,
  pushTopic,
  TAKEOVER_REASON,
  tripBlockage,
  type PushMessage,
  type TripBlockage,
} from "../domain/alerts";
import { datafonoLateAt, matchRestaurant } from "../domain/return-debts";
import { formatClock, isOpen, lastOpening } from "../domain/service-hours";
import { getBotConfig } from "./bot-config";
import { db } from "./client";
import { listRestaurants } from "./restaurants";
import { openDebtClaims, openReturnDebts } from "./return-debts";
import { getServiceHours, hoursFor } from "./service-hours";
import {
  assignments,
  conversations,
  couriers,
  messages,
  portalSessions,
  pushAlertState,
  pushSubscriptions,
  settings,
  trips,
  users,
} from "./schema";

/**
 * Alertas al celular (docs/INTERVENCION-MANUAL.md, «Alertas al celular»).
 *
 * Solo avisa lo que necesita a la central (bloqueos reales y emergencias), no
 * la operación normal: una moto asignada, un pedido que espera moto o un «Voy
 * en camino» sin tocar se ven en el tablero y no suenan en el celular.
 * Naranja (`attention`) pide atención; rojo (`critical`) es una emergencia o un
 * bloqueo grave en la calle. Con el portal cerrado eso lo vigila
 * el tick del bot (`runPushAlerts`, cada 5 s): cada fuente de abajo dice qué
 * cumple hoy su condición, y lo que entra por primera vez se manda como
 * notificación a todos los celulares que activaron las alertas.
 *
 * Para que una alerta nueva del portal llegue también al celular, basta con
 * agregar su fuente a `ALERT_SOURCES`.
 */

type AlertSource<Row> = {
  /** Nombre corto y fijo: se guarda en `push_alert_state.kind`. */
  kind: string;
  /** Lo que hoy cumple la condición de la alerta. */
  current: () => Promise<Row[]>;
  ref: (row: Row) => number;
  /** Cuándo pasó: lo viejo entra en silencio (`isFresh`). */
  at: (row: Row) => Date;
  message: (row: Row) => PushMessage;
};

/** La regla de «pide ayuda» del portal (`needsHelp` en apps/portal/src/lib/chat.ts),
 *  en SQL: escalado por el bot, y lo último no lo escribió la central. */
export function needsHelpCondition() {
  const lastRole = sql`(select ${messages.role} from ${messages}
    where ${messages.conversationId} = ${conversations.id}
    order by ${messages.id} desc limit 1)`;
  return and(
    eq(conversations.botPaused, true),
    sql`${conversations.escalationReason} is distinct from ${TAKEOVER_REASON}`,
    sql`coalesce(${lastRole}, '') <> 'agent'`,
  )!;
}

/** `needsHelpCondition` para el celular: además, sin los mensajes que llegan
 *  justo después de que la central escribió. Si el restaurante o el motorizado
 *  contesta «ok gracias» dentro del enfriamiento, el operador ya está en el
 *  chat y no hace falta avisar; el chat se sigue viendo en el portal. */
export function chatHelpPushCondition() {
  return and(
    needsHelpCondition(),
    sql`not exists (select 1 from ${messages} m
      where m.conversation_id = ${conversations.id} and m.role = 'agent'
        and m.created_at > ${conversations.lastMessageAt} - make_interval(mins => ${CHAT_HELP_COOLDOWN_MIN}))`,
  )!;
}

const chatHelp: AlertSource<{
  id: number;
  phone: string;
  displayName: string | null;
  courierName: string | null;
  restaurantName: string | null;
  reason: string | null;
  lastText: string | null;
  at: Date;
}> = {
  kind: "chat_help",
  current: () =>
    db
      .select({
        id: conversations.id,
        phone: conversations.phone,
        displayName: conversations.displayName,
        // Como en el portal: a un motorizado o restaurante registrado se le ve
        // por su nombre en el sistema, no por su perfil de WhatsApp. Los
        // nombres van con su tabla escritos a mano: en la lista del SELECT
        // Drizzle deja las columnas sin tabla, y dentro de la subconsulta
        // "phone" o "id" serían los de couriers, restaurants o messages.
        courierName: sql<string | null>`(select c.name from couriers c
          where c.active
            and right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = right(regexp_replace(conversations.phone, '\\D', '', 'g'), 10)
          limit 1)`,
        restaurantName: sql<string | null>`(select r.name from restaurants r
          where r.active and r.phone is not null
            and right(regexp_replace(r.phone, '\\D', '', 'g'), 10) = right(regexp_replace(conversations.phone, '\\D', '', 'g'), 10)
          limit 1)`,
        reason: conversations.escalationReason,
        lastText: sql<string | null>`(select m.text from messages m
          where m.conversation_id = conversations.id and m.role <> 'agent'
          order by m.id desc limit 1)`,
        at: conversations.lastMessageAt,
      })
      .from(conversations)
      .where(chatHelpPushCondition()),
  ref: (c) => c.id,
  at: (c) => c.at,
  message: (c) => chatHelpMessage({ id: c.id, phone: c.phone, name: c.courierName ?? c.restaurantName ?? c.displayName, reason: c.reason, lastText: c.lastText, at: c.at, courier: c.courierName !== null }),
};

const courierEmergency: AlertSource<{ id: number; name: string; at: Date }> = {
  kind: "courier_emergency",
  // La emergencia se marca desde Flota: la moto queda en «Pausado». El estado
  // no guarda desde cuándo, así que `at` es ahora y `isFresh` lo deja pasar.
  current: async () => {
    // Si el motorizado reportó una novedad por su chat, el bot lo pausa y
    // escala ese chat: ya avisa `chat_help`. Aquí solo la emergencia marcada a
    // mano en Flota, para no mandar dos avisos por lo mismo.
    const rows = await db
      .select({ id: couriers.id, name: couriers.name })
      .from(couriers)
      .where(
        and(
          eq(couriers.active, true),
          eq(couriers.status, "paused"),
          sql`not exists (select 1 from ${conversations}
            where right(regexp_replace(${conversations.phone}, '\\D', '', 'g'), 10) = right(regexp_replace(${couriers.phone}, '\\D', '', 'g'), 10)
              and ${conversations.botPaused}
              and ${conversations.escalationReason} is distinct from ${TAKEOVER_REASON})`,
        ),
      );
    const now = new Date();
    return rows.map((r) => ({ ...r, at: now }));
  },
  ref: (c) => c.id,
  at: (c) => c.at,
  message: (c) => courierEmergencyMessage(c),
};

type TripAlertRow = {
  id: number;
  code: string;
  restaurant: string;
  deliveryAddress: string;
  courierName: string;
  blockage: TripBlockage;
  minutes: number;
};

/** Viajes con moto que se atascaron. Cada tipo de bloqueo es su propia fuente
 *  (su propio `kind`): un viaje que pasa de uno a otro vuelve a avisar. */
function tripBlockages(kind: TripBlockage["kind"], build: (row: TripAlertRow) => PushMessage): AlertSource<TripAlertRow> {
  return {
    kind,
    current: async () => {
      const [config, rows] = await Promise.all([
        getBotConfig(),
        db
          .select({
            id: trips.id,
            code: trips.code,
            restaurant: trips.originRestaurantName,
            deliveryAddress: trips.deliveryAddress,
            courierName: assignments.courierName,
            status: trips.status,
            assignedAt: assignments.assignedAt,
            readyAt: trips.readyAt,
            pickedUpAt: assignments.pickedUpAt,
            customerWaitAt: assignments.customerWaitAt,
            undeliveredAt: assignments.undeliveredAt,
            deliveredAt: assignments.deliveredAt,
          })
          .from(trips)
          .innerJoin(assignments, eq(assignments.tripId, trips.id))
          .where(inArray(trips.status, ["assigned", "en_route"])),
      ]);
      const now = Date.now();
      return rows.flatMap((r) => {
        const blockage = tripBlockage(r, config);
        if (blockage?.kind !== kind || blockage.at.getTime() > now) return [];
        const minutes = kind === "return_late" ? config.returnAlertMinutes : config.deliveryAlertMinutes;
        return [{ id: r.id, code: r.code, restaurant: r.restaurant, deliveryAddress: r.deliveryAddress, courierName: r.courierName, blockage, minutes }];
      });
    },
    ref: (t) => t.id,
    at: (t) => t.blockage.at,
    message: build,
  };
}

const customerNoAnswer = tripBlockages("customer_no_answer", (t) => customerNoAnswerMessage({ ...t, at: t.blockage.at }));
const pickupLate = tripBlockages("pickup_late", (t) => pickupLateMessage({ ...t, at: t.blockage.at }));
const deliveryLate = tripBlockages("delivery_late", (t) => deliveryStalledMessage({ ...t, returning: false, at: t.blockage.at }));
const returnLate = tripBlockages("return_late", (t) => deliveryStalledMessage({ ...t, returning: true, at: t.blockage.at }));

const datafonoLate: AlertSource<{ id: number; courierName: string; restaurant: string; tripCode: string | null; minutes: number; at: Date }> = {
  kind: "datafono_late",
  // Un datáfono que lleva más de `datafonoAlertMinutes` afuera desde que se
  // entregó su pedido, y no se ha devuelto. Reemplaza la alerta de «Volviendo».
  current: async () => {
    const [debts, { datafonoAlertMinutes: minutes }] = await Promise.all([openReturnDebts(), getBotConfig()]);
    const now = Date.now();
    return debts.flatMap((d) => {
      const at = datafonoLateAt(d, minutes);
      return at && at.getTime() <= now ? [{ id: d.id, courierName: d.courierName, restaurant: d.restaurantName, tripCode: d.tripCode, minutes, at }] : [];
    });
  },
  ref: (d) => d.id,
  at: (d) => d.at,
  message: (d) => datafonoLateMessage(d),
};

const debtClaim: AlertSource<{
  id: number;
  restaurant: string;
  reason: "datafono" | "plata" | null;
  closing: boolean;
  why: string;
  at: Date;
}> = {
  kind: "debt_claim",
  current: async () => {
    const claims = await openDebtClaims();
    return claims.map((c) => ({
      id: c.id,
      restaurant: c.restaurantName,
      reason: c.reason,
      closing: c.closing,
      why: c.why,
      at: c.updatedAt,
    }));
  },
  ref: (c) => c.id,
  at: (c) => c.at,
  message: (c) => debtClaimMessage(c),
};

const datafonoClosing: AlertSource<{
  id: number;
  courierName: string;
  restaurant: string;
  tripCode: string | null;
  deadline: string;
  at: Date;
}> = {
  kind: "datafono_closing",
  // A la hora límite del restaurante todavía hay un datáfono afuera (#61).
  // La plata puede quedar para el día siguiente, sin alerta.
  current: async () => {
    const [debts, hours, restaurants] = await Promise.all([openReturnDebts(), getServiceHours(), listRestaurants()]);
    const now = new Date();
    const byId = new Map(restaurants.map((r) => [r.id, r]));
    return debts.flatMap((d) => {
      if (d.reason !== "datafono") return [];
      const r = (d.restaurantId ? byId.get(d.restaurantId) : null) ?? matchRestaurant(d.restaurantName, restaurants);
      const h = hoursFor(r ?? null, hours);
      if (isOpen(now, h)) return [];
      const opening = lastOpening(now, h.opensAt);
      if (d.createdAt.getTime() < opening.getTime()) return [];
      return [{ id: d.id, courierName: d.courierName, restaurant: d.restaurantName, tripCode: d.tripCode, deadline: formatClock(h.deadline), at: now }];
    });
  },
  ref: (d) => d.id,
  at: (d) => d.at,
  message: (d) => datafonoClosingMessage(d),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALERT_SOURCES: AlertSource<any>[] = [
  chatHelp,
  courierEmergency,
  customerNoAnswer,
  pickupLate,
  deliveryLate,
  returnLate,
  datafonoLate,
  debtClaim,
  datafonoClosing,
];

/**
 * Marca como dentro de la condición `refs` y devuelve las que acaban de
 * entrar. El UPDATE solo pasa si estaba fuera: entre dos ticks en paralelo,
 * solo uno ve cada entrada.
 */
async function enter(kind: string, refs: number[]): Promise<Set<number>> {
  if (refs.length === 0) return new Set();
  const rows = await db
    .insert(pushAlertState)
    .values(refs.map((ref) => ({ kind, ref, active: true })))
    .onConflictDoUpdate({
      target: [pushAlertState.kind, pushAlertState.ref],
      set: { active: true, changedAt: sql`now()` },
      setWhere: eq(pushAlertState.active, false),
    })
    .returning({ ref: pushAlertState.ref });
  return new Set(rows.map((r) => r.ref));
}

/** Lo que ya no cumple la condición queda fuera: si vuelve a entrar, suena otra vez. */
async function leave(kind: string, refs: number[]) {
  await db
    .update(pushAlertState)
    .set({ active: false, changedAt: sql`now()` })
    .where(
      and(
        eq(pushAlertState.kind, kind),
        eq(pushAlertState.active, true),
        refs.length > 0 ? notInArray(pushAlertState.ref, refs) : undefined,
      ),
    );
}

/** Revisa todas las fuentes y manda lo nuevo. Devuelve lo que se avisó. */
export async function runPushAlerts(now = new Date()): Promise<PushMessage[]> {
  await cleanupOnceAnHour();
  const fresh: PushMessage[] = [];
  for (const source of ALERT_SOURCES) {
    const rows = await source.current();
    const refs = rows.map(source.ref);
    const entered = await enter(source.kind, refs);
    await leave(source.kind, refs);
    for (const row of rows) {
      if (entered.has(source.ref(row)) && isFresh(source.at(row), now)) fresh.push(source.message(row));
    }
  }
  if (fresh.length === 0) return [];

  const subscriptions = await activeSubscriptions();
  if (subscriptions.length > 0) {
    await Promise.all(fresh.flatMap((message) => subscriptions.map((s) => sendOne(s, message))));
  }
  return fresh;
}

let lastCleanup = 0;

/** Sesiones vencidas (y con ellas sus suscripciones) y estados viejos fuera. */
async function cleanupOnceAnHour() {
  if (Date.now() - lastCleanup < 60 * 60 * 1000) return;
  lastCleanup = Date.now();
  await db.delete(portalSessions).where(lt(portalSessions.expiresAt, sql`now()`));
  // Esta fuente ya no existe: sus filas activas se quedarían para siempre.
  await db.delete(pushAlertState).where(eq(pushAlertState.kind, "trip_assigned"));
  await db
    .delete(pushAlertState)
    .where(and(eq(pushAlertState.active, false), lt(pushAlertState.changedAt, sql`now() - interval '3 days'`)));
}

// ---------------------------------------------------------------------------
// Envío (Web Push con VAPID)
// ---------------------------------------------------------------------------

const VAPID_SETTING = "web_push_vapid";

type VapidKeys = { publicKey: string; privateKey: string };

let vapid: VapidKeys | null = null;

/**
 * Las llaves con que el servidor firma cada aviso. Se crean solas la primera
 * vez y quedan en `settings`: el portal da la pública al celular al activar
 * las alertas y el bot firma con la privada. Si se borran, cada celular tiene
 * que volver a activarlas (el portal lo hace solo al abrirse).
 */
export async function getVapidKeys(): Promise<VapidKeys> {
  if (vapid) return vapid;
  const read = async () => {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, VAPID_SETTING));
    const value = row?.value as Partial<VapidKeys> | undefined;
    return value?.publicKey && value.privateKey ? { publicKey: value.publicKey, privateKey: value.privateKey } : null;
  };
  let keys = await read();
  if (!keys) {
    // Si dos procesos las crean a la vez, gana la primera y ambos leen esa.
    await db.insert(settings).values({ key: VAPID_SETTING, value: generateVAPIDKeys() }).onConflictDoNothing();
    keys = await read();
  }
  if (!keys) throw new Error("No se pudieron guardar las llaves de las alertas.");
  vapid = keys;
  return keys;
}

type Subscription = { id: number; endpoint: string; p256dh: string; auth: string; origin: string };

const subscriptionColumns = {
  id: pushSubscriptions.id,
  endpoint: pushSubscriptions.endpoint,
  p256dh: pushSubscriptions.p256dh,
  auth: pushSubscriptions.auth,
  origin: pushSubscriptions.origin,
};

/** Los celulares con alertas activas y sesión vigente, de usuarios activos. */
async function activeSubscriptions(sessionId?: number): Promise<Subscription[]> {
  return db
    .select(subscriptionColumns)
    .from(pushSubscriptions)
    .innerJoin(portalSessions, eq(portalSessions.id, pushSubscriptions.sessionId))
    .innerJoin(users, eq(users.id, portalSessions.userId))
    .where(
      and(
        gt(portalSessions.expiresAt, sql`now()`),
        eq(users.active, true),
        sessionId === undefined ? undefined : eq(portalSessions.id, sessionId),
      ),
    )
    .orderBy(desc(pushSubscriptions.id));
}

/** Apple exige como remitente una dirección https:// o mailto:. */
function subject(origin: string) {
  return origin.startsWith("https://") ? origin : "https://localhost";
}

export type SendResult = "sent" | "gone" | "failed";

async function sendOne(s: Subscription, message: PushMessage): Promise<SendResult> {
  const keys = await getVapidKeys();
  try {
    await sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(message), {
      TTL: ALERT_TTL_S,
      // Alta: Android la entrega enseguida aunque el celular esté en reposo.
      urgency: "high",
      topic: pushTopic(message.tag),
      timeout: 10_000,
      vapidDetails: { subject: subject(s.origin), publicKey: keys.publicKey, privateKey: keys.privateKey },
    });
    return "sent";
  } catch (error) {
    // 404/410: el celular ya no la acepta (desinstaló, bloqueó o cambió de
    // navegador). Se borra; si las vuelve a activar se crea otra.
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
      return "gone";
    }
    const detail = error instanceof WebPushError ? `${error.statusCode} ${error.body}` : String(error);
    console.error(`[alertas] no se pudo avisar a la suscripción ${s.id}: ${detail}`);
    return "failed";
  }
}

/** El aviso de prueba del portal: solo a los celulares de esa sesión. */
export async function sendPushToSession(sessionId: number, message: PushMessage): Promise<SendResult[]> {
  const subscriptions = await activeSubscriptions(sessionId);
  return Promise.all(subscriptions.map((s) => sendOne(s, message)));
}

// ---------------------------------------------------------------------------
// Suscripciones (las guarda el portal)
// ---------------------------------------------------------------------------

/** Guarda o mueve a esta sesión la suscripción de un navegador. */
export async function saveSubscription(input: {
  sessionId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  origin: string;
}) {
  await db
    .insert(pushSubscriptions)
    .values(input)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { sessionId: input.sessionId, p256dh: input.p256dh, auth: input.auth, origin: input.origin },
    });
}

/** Quita una suscripción, solo si es de esta sesión. */
export async function deleteSubscription(sessionId: number, endpoint: string) {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.sessionId, sessionId), eq(pushSubscriptions.endpoint, endpoint)));
}

/** Cuántas sesiones tienen alertas activas, por id de sesión. */
export async function subscriptionCounts(sessionIds: number[]): Promise<Map<number, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .select({ sessionId: pushSubscriptions.sessionId, n: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.sessionId, sessionIds))
    .groupBy(pushSubscriptions.sessionId);
  return new Map(rows.map((r) => [r.sessionId, r.n]));
}
