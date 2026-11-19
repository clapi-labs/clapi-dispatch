import os from "node:os";
import path from "node:path";

/**
 * Dónde y por cuánto tiempo se guardan las fotos de los chats. Las leen el bot
 * (que las escribe y las limpia) y el portal (que las sirve), así que las
 * dos apps tienen que ver la misma carpeta: en el servidor es un volumen de
 * Docker (`/data/media`); en local, una carpeta del sistema en común.
 *
 * Se lee al usarse, no al importar: Next evalúa los módulos durante el build
 * sin las variables a mano.
 */

export const MEDIA_DEFAULTS = {
  retentionDays: 30,
  maxMb: 3072,
  maxDiskPercent: 75,
} as const;

export type MediaConfig = {
  /** Carpeta raíz; adentro, una por día (`AAAA-MM-DD`). */
  dir: string;
  /** Pasado este tiempo, la foto se borra. */
  retentionDays: number;
  /** Tope de espacio de la carpeta, en bytes. */
  maxBytes: number;
  /** Si el disco del servidor pasa de este porcentaje, se borra lo más viejo. */
  maxDiskPercent: number;
};

/** El número positivo de la variable, o el valor por defecto si falta o no sirve. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function mediaConfig(env: Record<string, string | undefined> = process.env): MediaConfig {
  const percent = positiveNumber(env.MEDIA_MAX_DISK_PERCENT, MEDIA_DEFAULTS.maxDiskPercent);
  return {
    dir: env.MEDIA_DIR?.trim() || path.join(os.tmpdir(), "clapi-dispatch-media"),
    retentionDays: Math.max(1, Math.floor(positiveNumber(env.MEDIA_RETENTION_DAYS, MEDIA_DEFAULTS.retentionDays))),
    maxBytes: Math.floor(positiveNumber(env.MEDIA_MAX_MB, MEDIA_DEFAULTS.maxMb) * 1024 * 1024),
    maxDiskPercent: Math.min(percent, 100),
  };
}
