/**
 * Cuánto se guarda de lo que crece sin límite (issue #103). Lo aplica
 * `runRetention` (db/retention.ts) desde el tick del bot, una vez por hora.
 *
 * - `processed_messages`: los wamid ya atendidos, para no responder dos veces
 *   el mismo webhook. Meta reintenta por horas, no por semanas: 14 días sobran.
 * - `engine_evaluations`: la foto completa de cada decisión del algoritmo
 *   (~10 kB por fila). Sirve para explicar y repetir decisiones recientes.
 * - `messages`: los chats. No hay coexistencia con WhatsApp Business, así que
 *   esta tabla es el único historial: por defecto se guarda un año.
 *
 * `trips` y `assignments` no se borran nunca: son el historial operativo y lo
 * que usa Finanzas.
 *
 * Cada una se cambia por variable de entorno, en días; `0` u `off` la apaga.
 */

export type RetentionConfig = {
  processedMessagesDays: number | null;
  engineEvaluationsDays: number | null;
  messagesDays: number | null;
};

export const RETENTION_DEFAULTS = {
  processedMessagesDays: 14,
  engineEvaluationsDays: 30,
  messagesDays: 365,
} as const satisfies Record<keyof RetentionConfig, number>;

/** Lo mínimo que se acepta: un valor menor se sube a este. Un error al
 *  escribir la variable (`RETENTION_MESSAGES_DAYS=3`) no puede borrar casi
 *  todo el historial de los chats. */
export const RETENTION_MINIMUMS = {
  processedMessagesDays: 2,
  engineEvaluationsDays: 2,
  messagesDays: 30,
} as const satisfies Record<keyof RetentionConfig, number>;

const ENV_NAMES = {
  processedMessagesDays: "RETENTION_PROCESSED_MESSAGES_DAYS",
  engineEvaluationsDays: "RETENTION_ENGINE_EVALUATIONS_DAYS",
  messagesDays: "RETENTION_MESSAGES_DAYS",
} as const satisfies Record<keyof RetentionConfig, string>;

/** Vacía o inválida: el valor por defecto. `0`/`off`: sin borrar. */
function parseDays(raw: string | undefined, fallback: number, minimum: number): number | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "0" || value === "off" || value === "no") return null;
  if (!/^\d+$/.test(value)) return fallback;
  return Math.max(Number(value), minimum);
}

export function retentionConfig(env: Record<string, string | undefined> = process.env): RetentionConfig {
  const keys = Object.keys(ENV_NAMES) as (keyof RetentionConfig)[];
  return Object.fromEntries(
    keys.map((key) => [key, parseDays(env[ENV_NAMES[key]], RETENTION_DEFAULTS[key], RETENTION_MINIMUMS[key])]),
  ) as RetentionConfig;
}

/** Desde cuándo se conserva: lo anterior a esta fecha se borra. */
export function retentionCutoff(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
