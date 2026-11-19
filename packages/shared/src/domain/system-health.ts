import { SEVERITY_PREFIX, type PushMessage } from "./alerts";

/**
 * Salud del servidor (issue #103): qué tan lleno está el disco y cuándo avisar.
 * Lo mide `systemHealth` (db/system-health.ts); lo muestra el portal en
 * /salud y el tick del bot manda la alerta al celular (`diskFull` en
 * db/push.ts).
 */

/** Desde qué porcentaje de disco usado se avisa. */
export const DISK_WARNING_PCT = 75;
export const DISK_CRITICAL_PCT = 85;

export type DiskLevel = "ok" | "warning" | "critical";

export type DiskUsage = { path: string; total: number; used: number; free: number; usedPct: number };

export function diskLevel(usedPct: number): DiskLevel {
  if (usedPct >= DISK_CRITICAL_PCT) return "critical";
  if (usedPct >= DISK_WARNING_PCT) return "warning";
  return "ok";
}

/** Cuánto tiene que bajar el disco para que la alerta se dé por resuelta: sin
 *  este margen, un disco que oscila alrededor del 75 % avisaría una y otra vez. */
export const DISK_ALERT_MARGIN_PCT = 2;

/** Como `diskLevel`, pero una alerta ya activa se mantiene hasta que el disco
 *  baje `DISK_ALERT_MARGIN_PCT` puntos por debajo de su umbral. */
export function diskAlertLevel(usedPct: number, previous: DiskLevel): DiskLevel {
  const level = diskLevel(usedPct);
  if (level === "critical") return level;
  if (previous === "critical" && usedPct >= DISK_CRITICAL_PCT - DISK_ALERT_MARGIN_PCT) return "critical";
  if (level === "warning") return level;
  if (previous !== "ok" && usedPct >= DISK_WARNING_PCT - DISK_ALERT_MARGIN_PCT) return "warning";
  return "ok";
}

/** De lo que devuelve `statfs` a bytes. `free` es lo que puede usar un proceso
 *  normal (`bavail`); lo reservado para root cuenta como usado, igual que `df`. */
export function diskUsageFromStatfs(path: string, s: { bsize: number; blocks: number; bfree: number; bavail: number }): DiskUsage {
  const total = s.blocks * s.bsize;
  const used = (s.blocks - s.bfree) * s.bsize;
  const free = s.bavail * s.bsize;
  const usable = used + free;
  const usedPct = usable > 0 ? Math.round((used / usable) * 1000) / 10 : 0;
  return { path, total, used, free, usedPct };
}

const UNITS = ["B", "kB", "MB", "GB", "TB"];

/** 1536 → "1,5 kB". Base 1024, una cifra decimal, coma como en el resto del portal. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(".", ",");
  return `${text} ${UNITS[unit]}`;
}

/** El aviso al celular cuando el disco pasa el 75 % o el 85 %. */
export function diskAlertMessage(disk: DiskUsage, level: Exclude<DiskLevel, "ok">, now = new Date()): PushMessage {
  const critical = level === "critical";
  const pct = String(disk.usedPct).replace(".", ",");
  return {
    severity: critical ? "critical" : "attention",
    title: critical ? `${SEVERITY_PREFIX.critical} Disco casi lleno: ${pct} %` : `${SEVERITY_PREFIX.attention} Disco al ${pct} %`,
    body: `Quedan ${formatBytes(disk.free)} libres de ${formatBytes(disk.total)}. ${
      critical ? "Hay que liberar espacio ya: si se llena, se detienen los chats y la base." : "Conviene revisar qué está creciendo."
    }`,
    url: "/salud",
    tag: "disk",
    at: now.getTime(),
  };
}
