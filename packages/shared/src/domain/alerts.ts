/**
 * Alertas al celular (docs/INTERVENCION-MANUAL.md, «Alertas al celular»): el
 * texto de cada notificación y las reglas que no dependen de la base. La
 * detección y el envío están en `db/push.ts`.
 */

/** Lo que recibe el service worker del portal (`public/sw.js`). */
export type PushMessage = {
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

/** Un chat empezó a pedir ayuda a la central. */
export function chatHelpMessage(chat: {
  id: number;
  phone: string;
  /** El nombre de Flota si es un motorizado; si no, el de su WhatsApp. */
  name: string | null;
  reason: string | null;
  lastText: string | null;
  at: Date;
}): PushMessage {
  const who = chat.name?.trim() || formatPhoneCO(chat.phone);
  const why = chat.reason?.trim() || chat.lastText?.trim() || "Escribió y espera respuesta.";
  return {
    title: `${who} pide ayuda`,
    body: clip(why),
    // El mismo enlace que usa el portal para abrir un chat por su número.
    url: `/conversaciones#tel=${digits(chat.phone)}`,
    tag: `chat-${chat.id}`,
    at: chat.at.getTime(),
  };
}

/** Un viaje quedó con moto: lo mismo que dice el aviso del portal. */
export function tripAssignedMessage(trip: {
  id: number;
  code: string;
  courierName: string;
  restaurant: string;
  deliveryAddress: string;
  at: Date;
}): PushMessage {
  return {
    title: `Moto asignada · ${trip.code}`,
    body: clip(`${trip.courierName} → ${trip.deliveryAddress} (recoge en ${trip.restaurant})`),
    url: `/viajes#pedido=${trip.id}`,
    tag: `pedido-${trip.id}`,
    at: trip.at.getTime(),
  };
}

/** El aviso de prueba que se manda desde el portal al activar las alertas. */
export function testMessage(now = new Date()): PushMessage {
  return {
    title: "Alertas activas",
    body: "Así te llegan los avisos del portal: chats que piden ayuda y motos asignadas.",
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
