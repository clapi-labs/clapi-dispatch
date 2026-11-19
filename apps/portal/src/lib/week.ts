/**
 * Semanas y días de Finanzas, medidos en hora de Colombia (America/Bogota,
 * UTC−5 todo el año: no hay cambio de hora). Sin librerías ni `Intl`: el
 * servidor corre en UTC y no se puede depender de la zona de la máquina.
 *
 * Una fecha de calendario va como texto `YYYY-MM-DD`. La semana va de lunes
 * a domingo. Los límites de un día son [medianoche de Colombia, medianoche
 * siguiente), es decir, 05:00 UTC de ese día y 05:00 UTC del siguiente.
 */

const BOGOTA_OFFSET_MS = 5 * 3600_000;
const DAY_MS = 86400_000;

export const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const;
export const DAY_NAMES_LONG = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` válido (el día existe en el calendario), o `null`. */
export function parseYmd(value: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = value ? YMD.exec(value) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Los días desde 1970-01-01 de una fecha de calendario (no de un instante). */
function dayNumber(ymd: string): number {
  const p = parseYmd(ymd);
  if (!p) throw new Error(`Fecha inválida: ${ymd}`);
  return Date.UTC(p.y, p.m - 1, p.d) / DAY_MS;
}

function fromDayNumber(n: number): string {
  const d = new Date(n * DAY_MS);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** La fecha `ymd` movida `days` días (puede ser negativo). */
export function addDays(ymd: string, days: number): string {
  return fromDayNumber(dayNumber(ymd) + days);
}

/** La fecha de calendario de Colombia a la que pertenece un instante. */
export function bogotaDate(instant: Date | number): string {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  return fromDayNumber(Math.floor((ms - BOGOTA_OFFSET_MS) / DAY_MS));
}

/** El instante (UTC) en que empieza ese día en Colombia: 00:00 de Bogotá. */
export function dayStart(ymd: string): Date {
  return new Date(dayNumber(ymd) * DAY_MS + BOGOTA_OFFSET_MS);
}

/** 0 = lunes … 6 = domingo. */
export function weekdayIndex(ymd: string): number {
  // 1970-01-01 fue jueves (índice 3 con la semana desde el lunes).
  return (((dayNumber(ymd) + 3) % 7) + 7) % 7;
}

/** El lunes de la semana a la que pertenece esa fecha. */
export function weekStart(ymd: string): string {
  return addDays(ymd, -weekdayIndex(ymd));
}

export type WeekDay = {
  /** `YYYY-MM-DD`. */
  date: string;
  /** 0 = lunes … 6 = domingo. */
  index: number;
  /** Desde (incluido), medianoche de Colombia. */
  from: Date;
  /** Hasta (excluido), la medianoche siguiente. */
  to: Date;
};

export type WeekRange = {
  /** El lunes. */
  start: string;
  /** El domingo. */
  end: string;
  /** Lunes 00:00 de Colombia (incluido). */
  from: Date;
  /** Lunes siguiente 00:00 de Colombia (excluido): el domingo 23:59:59.999 queda dentro. */
  to: Date;
  days: WeekDay[];
};

/** La semana (lunes a domingo) que contiene `ymd`, con los límites de cada día. */
export function weekRange(ymd: string): WeekRange {
  const start = weekStart(ymd);
  const days: WeekDay[] = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    return { date, index, from: dayStart(date), to: dayStart(addDays(date, 1)) };
  });
  return { start, end: days[6].date, from: days[0].from, to: days[6].to, days };
}

/** «18 nov». */
export function shortDate(ymd: string): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return `${p.d} ${MONTHS[p.m - 1]}`;
}

/** «Lunes 16 nov». */
export function longDate(ymd: string): string {
  return `${DAY_NAMES_LONG[weekdayIndex(ymd)]} ${shortDate(ymd)}`;
}
