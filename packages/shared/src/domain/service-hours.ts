/**
 * El horario en que se reciben servicios (docs/BOT.md, «Horario»): una hora de
 * inicio para todos y una hora límite por restaurante, igual todos los días.
 * Las horas son de Cali y se guardan como "HH:MM" en 24 horas.
 *
 * La hora límite puede pasar la medianoche: con inicio a las 10:00 y límite a
 * la 01:30, se recibe de 10:00 a 23:59 y de 00:00 a 01:29.
 */

export type ServiceHours = {
  /** Desde qué hora se reciben servicios, para todos los restaurantes. */
  opensAt: string;
  /** La hora límite de un restaurante que no tiene una propia. */
  defaultDeadline: string;
};

export const DEFAULT_SERVICE_HOURS: ServiceHours = { opensAt: "10:00", defaultDeadline: "23:30" };

/** Minutos antes de la hora límite en que sale el recordatorio. */
export const CLOSING_REMINDER_MINUTES = 10;

/** Colombia no cambia de hora: Cali siempre es UTC−5. */
const CALI_OFFSET_MINUTES = -5 * 60;
const DAY = 24 * 60;
const MINUTE_MS = 60_000;

/** "HH:MM" (24 horas) a minutos desde la medianoche; null si no es una hora. */
export function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** La misma hora, siempre como "HH:MM"; null si no es una hora. */
export function normalizeClock(value: unknown): string | null {
  const minutes = parseClock(value);
  if (minutes === null) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Como se le dice a una persona: "10:00 a. m.", "11:30 p. m.", "12:00 m.". */
export function formatClock(value: string): string {
  const minutes = parseClock(value) ?? 0;
  const h = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(2, "0");
  if (minutes === 12 * 60) return "12:00 m.";
  const suffix = h < 12 ? "a. m." : "p. m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${suffix}`;
}

/** Minutos desde la medianoche en Cali. */
function caliMinutes(now: Date) {
  const utc = Math.floor(now.getTime() / MINUTE_MS);
  return (((utc + CALI_OFFSET_MINUTES) % DAY) + DAY) % DAY;
}

/** El último momento en que abrió (la hora de inicio de hoy o, si todavía no
 *  llega, la de ayer). Cada apertura empieza una jornada nueva. */
export function lastOpening(now: Date, opensAt: string): Date {
  const open = parseClock(opensAt) ?? 0;
  const since = (caliMinutes(now) - open + DAY) % DAY;
  const at = new Date(now.getTime() - since * MINUTE_MS);
  at.setUTCSeconds(0, 0);
  return at;
}

/**
 * Cuántos minutos le quedan a la jornada antes de la hora límite, contando
 * desde la apertura. Null si está fuera de horario. Si el límite es igual a
 * la apertura, se recibe todo el día.
 */
export function minutesLeft(now: Date, hours: { opensAt: string; deadline: string }): number | null {
  const open = parseClock(hours.opensAt) ?? 0;
  const close = parseClock(hours.deadline) ?? open;
  const length = (close - open + DAY) % DAY || DAY;
  const elapsed = (caliMinutes(now) - open + DAY) % DAY;
  return elapsed < length ? length - elapsed : null;
}

export function isOpen(now: Date, hours: { opensAt: string; deadline: string }) {
  return minutesLeft(now, hours) !== null;
}

/**
 * El aviso de fuera de horario sale una vez por cierre: si ya se le dio
 * después de la última apertura, no se repite hasta la próxima jornada.
 */
export function closedNoticeDue(now: Date, opensAt: string, lastNoticeAt: Date | null) {
  return !lastNoticeAt || lastNoticeAt < lastOpening(now, opensAt);
}

/** Lo que responde el bot fuera de horario. Antes de abrir, en la mañana, es
 *  «hoy»; de noche y de madrugada, «mañana». */
export function closedMessage(now: Date, opensAt: string) {
  const morning = caliMinutes(now) >= 5 * 60 && caliMinutes(now) < (parseClock(opensAt) ?? 0);
  return `A esta hora ya no recibimos servicios para tu restaurante 🙏 Te esperamos ${morning ? "hoy" : "mañana"} desde las ${formatClock(opensAt)}`;
}

/** El recordatorio a quien tiene un pedido a medio armar cerca del cierre. La
 *  hora ya termina en punto («p. m.»), así que no se le pone otro. */
export function closingReminderMessage(deadline: string) {
  return `⏰ Recibimos servicios hasta las ${formatClock(deadline)} Confirma tu pedido antes de esa hora o ya no lo podremos recibir 🙏`;
}
