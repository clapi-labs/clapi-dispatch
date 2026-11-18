/**
 * Alertas al celular (docs/INTERVENCION-MANUAL.md, «Alertas al celular»): el
 * texto de cada notificación y las reglas que no dependen de la base. La
 * detección y el envío están en `db/push.ts`.
 */

/**
 * Cuánto necesita a la central lo que se avisa. 🟠 `attention`: alguien
 * requiere atención, hay margen. 🔴 `critical`: emergencia o bloqueo grave en
 * la calle. El service worker (`public/sw.js`) cambia ícono, vibración y si la
 * notificación se queda hasta que la toquen.
 */
export type AlertSeverity = "attention" | "critical";

/** Prefijo del título de cada nivel. */
export const SEVERITY_PREFIX: Record<AlertSeverity, string> = { attention: "⚠️", critical: "🚨" };

/** Lo que recibe el service worker del portal (`public/sw.js`). */
export type PushMessage = {
  severity: AlertSeverity;
  title: string;
  body: string;
  /** Dónde abre el portal al tocarla. Ruta del portal, sin dominio. */
  url: string;
  /** Una por chat o por pedido: la nueva reemplaza a la anterior del mismo
   *  tag en vez de apilarse. También se usa como `Topic` de Web Push, que
   *  hace lo mismo con las que esperan a un celular apagado. */
  tag: string;
  /** Cuándo pasó, en milisegundos. */
  at: number;
};

/** La razón que queda cuando alguien de la central toma el chat por su cuenta
 *  («Intervenir»): ese chat no pide ayuda, ya hay alguien en él. */
export const TAKEOVER_REASON = "Un operador tomó la conversación.";

/** Lo que pasó hace más de esto ya no se avisa: al encender las alertas por
 *  primera vez, o si el servidor estuvo caído, no llueven avisos viejos. */
export const ALERT_FRESH_MS = 10 * 60 * 1000;

/** Sin conexión, el servicio de notificaciones guarda el aviso hasta este
 *  tiempo (segundos). Más tarde ya no sirve: se ve en el portal. */
export const ALERT_TTL_S = 15 * 60;

export function isFresh(at: Date, now = new Date()): boolean {
  return now.getTime() - at.getTime() <= ALERT_FRESH_MS;
}

/** Cuánto dura una sesión del portal, en segundos. */
export const SESSION_HOURS_BROWSER = 12;
export const SESSION_DAYS_INSTALLED = 30;

export function sessionMaxAge(installed: boolean): number {
  return installed ? SESSION_DAYS_INSTALLED * 24 * 60 * 60 : SESSION_HOURS_BROWSER * 60 * 60;
}

const MAX_BODY = 160;

function clip(text: string, max = MAX_BODY): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function digits(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.length <= 10 ? `57${d}` : d;
}

/** Como lo muestra el portal: +57 300 123 4567. */
export function formatPhoneCO(phone: string): string {
  const d = digits(phone);
  return d.length === 12 && d.startsWith("57") ? `+57 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : phone;
}

/** Minutos tras el último mensaje de la central en que el chat no vuelve a
 *  avisar: ya hay alguien atendiéndolo y un «ok gracias» no es una alerta. */
export const CHAT_HELP_COOLDOWN_MIN = 5;

/** Un chat empezó a pedir ayuda a la central. Si es de un motorizado (accidente,
 *  varada, robo, pedido dañado…) es rojo; si es de un restaurante, naranja. */
export function chatHelpMessage(chat: {
  id: number;
  phone: string;
  /** El nombre de Flota si es un motorizado; si no, el del restaurante o el de su WhatsApp. */
  name: string | null;
  reason: string | null;
  lastText: string | null;
  at: Date;
  /** El chat es de un motorizado registrado. */
  courier?: boolean;
}): PushMessage {
  const who = chat.name?.trim() || formatPhoneCO(chat.phone);
  const why = chat.reason?.trim() || chat.lastText?.trim() || "Escribió y espera respuesta.";
  const severity: AlertSeverity = chat.courier ? "critical" : "attention";
  return {
    severity,
    title: `${SEVERITY_PREFIX[severity]} ${who} pide ayuda`,
    body: clip(why),
    // El mismo enlace que usa el portal para abrir un chat por su número.
    url: `/conversaciones#tel=${digits(chat.phone)}`,
    tag: `chat-${chat.id}`,
    at: chat.at.getTime(),
  };
}

/** Un motorizado quedó en «Pausado» desde Flota: así se marca una emergencia. */
export function courierEmergencyMessage(courier: { id: number; name: string; at: Date }): PushMessage {
  return {
    severity: "critical",
    title: `${SEVERITY_PREFIX.critical} Emergencia · ${courier.name}`,
    body: "Está marcado en pausa en Flota. Llámalo.",
    url: "/flota",
    tag: `emergencia-${courier.id}`,
    at: courier.at.getTime(),
  };
}

/** El domiciliario avisó que el cliente no contesta. */
export function customerNoAnswerMessage(trip: { id: number; code: string; courierName: string; deliveryAddress: string; at: Date }): PushMessage {
  return {
    severity: "attention",
    title: `${SEVERITY_PREFIX.attention} Cliente no contesta · ${trip.code}`,
    body: clip(`${trip.courierName} espera en ${trip.deliveryAddress}.`),
    url: `/viajes#pedido=${trip.id}`,
    tag: `pedido-${trip.id}`,
    at: trip.at.getTime(),
  };
}

/** La moto sigue sin recoger pasado el tiempo. */
export function pickupLateMessage(trip: { id: number; code: string; courierName: string; restaurant: string; at: Date }): PushMessage {
  return {
    severity: "critical",
    title: `${SEVERITY_PREFIX.critical} Moto no recoge · ${trip.code}`,
    body: clip(`${trip.courierName} no ha recogido en ${trip.restaurant}.`),
    url: `/viajes#pedido=${trip.id}`,
    tag: `pedido-${trip.id}`,
    at: trip.at.getTime(),
  };
}

/** La entrega, o la devolución de un pedido no entregado, lleva demasiado. */
export function deliveryStalledMessage(trip: {
  id: number;
  code: string;
  courierName: string;
  deliveryAddress: string;
  returning: boolean;
  minutes: number;
  at: Date;
}): PushMessage {
  return {
    severity: "critical",
    title: `${SEVERITY_PREFIX.critical} ${trip.returning ? "Devolución estancada" : "Entrega estancada"} · ${trip.code}`,
    body: clip(
      trip.returning
        ? `${trip.courierName} lleva más de ${trip.minutes} min devolviendo el pedido.`
        : `${trip.courierName} lleva más de ${trip.minutes} min con el pedido para ${trip.deliveryAddress}.`,
    ),
    url: `/viajes#pedido=${trip.id}`,
    tag: `pedido-${trip.id}`,
    at: trip.at.getTime(),
  };
}

type Stamp = Date | string | null | undefined;

const minutes = (m: number) => m * 60_000;
const time = (t: Stamp) => (t ? new Date(t).getTime() : null);

export type TripBlockageInput = {
  status: string;
  assignedAt: Stamp;
  readyAt?: Stamp;
  pickedUpAt?: Stamp;
  customerWaitAt?: Stamp;
  undeliveredAt?: Stamp;
  deliveredAt?: Stamp;
};

export type TripBlockageConfig = { pickupLateMinutes: number; deliveryAlertMinutes: number; returnAlertMinutes: number };

export type TripBlockage = { kind: "customer_no_answer" | "pickup_late" | "delivery_late" | "return_late"; at: Date };

/**
 * Los bloqueos reales de un viaje con moto, y desde cuándo. Solo estos llegan
 * al celular; el resto de las demoras (pedido sin moto, «Voy en camino» sin
 * tocar, salió de la entrega sin marcarla) se ven en la tarjeta del tablero.
 */
export function tripBlockage(t: TripBlockageInput, c: TripBlockageConfig): TripBlockage | null {
  if (t.status !== "assigned" && t.status !== "en_route") return null;
  if (t.deliveredAt) return null;
  // Pasada la espera, el pedido vuelve: `customerWaitAt` sigue puesto, pero ya
  // no es un cliente que no contesta sino una devolución en curso.
  const undeliveredAt = time(t.undeliveredAt);
  if (undeliveredAt !== null) return { kind: "return_late", at: new Date(undeliveredAt + minutes(c.returnAlertMinutes)) };
  const customerWaitAt = time(t.customerWaitAt);
  if (t.status === "en_route" && customerWaitAt !== null) return { kind: "customer_no_answer", at: new Date(customerWaitAt) };
  const pickedUpAt = time(t.pickedUpAt);
  if (pickedUpAt !== null) return { kind: "delivery_late", at: new Date(pickedUpAt + minutes(c.deliveryAlertMinutes)) };
  // Igual que `pickupLateAt` (phase.ts): desde la hora de listo, o desde la asignación si fue más tarde.
  const base = Math.max(time(t.assignedAt) ?? 0, time(t.readyAt) ?? 0);
  return { kind: "pickup_late", at: new Date(base + minutes(c.pickupLateMinutes)) };
}

/** Un datáfono lleva demasiado afuera desde que se entregó su pedido
 *  (pendientes de regreso). Solo avisa la demora: no cambia la asignación. */
export function datafonoLateMessage(debt: { id: number; courierName: string; restaurant: string; tripCode: string | null; minutes: number; at: Date }): PushMessage {
  return {
    severity: "attention",
    title: `${SEVERITY_PREFIX.attention} Datáfono sin devolver · ${debt.restaurant}`,
    body: clip(`${debt.courierName} lo tiene hace más de ${debt.minutes} min${debt.tripCode ? ` (${debt.tripCode})` : ""}.`),
    url: "/pendientes",
    tag: `datafono-${debt.id}`,
    at: debt.at.getTime(),
  };
}

/** Un restaurante reclamó su plata o su datáfono y requiere a la central (#61). */
export function debtClaimMessage(claim: {
  id: number;
  restaurant: string;
  reason: "datafono" | "plata" | null;
  closing: boolean;
  why: string;
  at: Date;
}): PushMessage {
  const what = claim.reason === "datafono" ? "datáfono" : claim.reason === "plata" ? "plata" : "pendiente";
  return {
    severity: "attention",
    title: `${SEVERITY_PREFIX.attention} Reclamo de ${what} · ${claim.restaurant}${claim.closing ? " (cierra)" : ""}`,
    body: clip(claim.why),
    url: "/pendientes",
    tag: `reclamo-${claim.id}`,
    at: claim.at.getTime(),
  };
}

/** A la hora límite del restaurante todavía hay un datáfono afuera (#61). */
export function datafonoClosingMessage(debt: {
  id: number;
  courierName: string;
  restaurant: string;
  tripCode: string | null;
  deadline: string;
  at: Date;
}): PushMessage {
  return {
    severity: "attention",
    title: `${SEVERITY_PREFIX.attention} Datáfono afuera al cierre · ${debt.restaurant}`,
    body: clip(`${debt.courierName} todavía tiene el datáfono${debt.tripCode ? ` (${debt.tripCode})` : ""} y cerró a las ${debt.deadline}.`),
    url: "/pendientes",
    tag: `datafono-cierre-${debt.id}`,
    at: debt.at.getTime(),
  };
}

/** El aviso de prueba que se manda desde el portal al activar las alertas. */
export function testMessage(now = new Date()): PushMessage {
  return {
    severity: "attention",
    title: `${SEVERITY_PREFIX.attention} Alertas activas`,
    body: "Así te llegan los avisos del portal: chats que piden ayuda, motos que no recogen o no entregan, y datáfonos sin devolver. 🚨 es una emergencia.",
    url: "/alertas",
    tag: "prueba",
    at: now.getTime(),
  };
}

/** Para reconocer cada sesión en la lista: «iPhone · Safari», «Android · Chrome». */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /EdgA?\//.test(ua)
    ? "Edge"
    : /SamsungBrowser\//.test(ua)
      ? "Samsung Internet"
      : /(Firefox|FxiOS)\//.test(ua)
        ? "Firefox"
        : /(Chrome|CriOS)\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  return [os, browser].filter(Boolean).join(" · ") || "Navegador";
}

/** El `Topic` de Web Push solo admite hasta 32 caracteres de base64url. */
export function pushTopic(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}
