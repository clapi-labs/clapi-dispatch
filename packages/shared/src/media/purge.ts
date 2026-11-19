import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

import type { MediaConfig } from "./config";
import { dayFolder, isDayFolder, resolveMediaPath } from "./paths";

/**
 * La limpieza de las fotos, con doble candado:
 *
 *   1. **Tiempo**: se borra lo que tiene más de `retentionDays`.
 *   2. **Espacio**: si la carpeta pasa de `maxBytes`, o el disco del servidor
 *      pasa de `maxDiskPercent`, se borra lo más viejo hasta quedar debajo.
 *
 * `planPurge` es la decisión (pura, sin disco ni base) y `purgeMedia` la
 * ejecuta. La base solo guarda referencias (`messages.media_*`); aquí se borra
 * el archivo y la fila queda marcada como `expired`, para que el portal
 * muestre «imagen expirada» y no una imagen rota.
 */

export type MediaRow = { id: number; path: string; bytes: number; createdAt: Date };

export type DiskUsage = { usedBytes: number; totalBytes: number };

export type PurgeInput = {
  rows: MediaRow[];
  now: Date;
  config: Pick<MediaConfig, "retentionDays" | "maxBytes" | "maxDiskPercent">;
  /** Lo que ocupa hoy la carpeta de fotos, medido en disco (cuenta también lo huérfano). */
  folderBytes: number;
  /** El disco donde vive la carpeta; `null` si no se pudo medir (no se aplica ese tope). */
  disk: DiskUsage | null;
};

export type PurgePlan = {
  /** Pasaron los días de retención. */
  ttl: MediaRow[];
  /** Hubo que liberar espacio: de la más vieja a la más nueva. */
  space: MediaRow[];
};

const DAY_MS = 86_400_000;

const byAge = (a: MediaRow, b: MediaRow) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;

export function planPurge({ rows, now, config, folderBytes, disk }: PurgeInput): PurgePlan {
  const cutoff = now.getTime() - config.retentionDays * DAY_MS;
  const ttl = rows.filter((r) => r.createdAt.getTime() < cutoff).sort(byAge);
  const remaining = rows.filter((r) => r.createdAt.getTime() >= cutoff).sort(byAge);

  const ttlBytes = ttl.reduce((sum, r) => sum + r.bytes, 0);
  let folder = folderBytes - ttlBytes;
  let used = disk ? disk.usedBytes - ttlBytes : 0;
  const diskOver = () => !!disk && config.maxDiskPercent > 0 && disk.totalBytes > 0 && (used / disk.totalBytes) * 100 > config.maxDiskPercent;

  const space: MediaRow[] = [];
  while (remaining.length > 0 && (folder > config.maxBytes || diskOver())) {
    const oldest = remaining.shift()!;
    space.push(oldest);
    folder -= oldest.bytes;
    used -= oldest.bytes;
  }
  return { ttl, space };
}

/** Lo que `purgeMedia` necesita de la base: las fotos en disco y marcar las borradas. */
export type MediaIndex = {
  listStored(): Promise<MediaRow[]>;
  markExpired(ids: number[], reason: "ttl" | "space", at: Date): Promise<void>;
};

export type PurgeResult = {
  ttl: number;
  space: number;
  freedBytes: number;
  /** Carpetas de días viejos que se quitaron enteras (traen también lo huérfano). */
  foldersRemoved: number;
};

/** Cuánto ocupan, en bytes, todos los archivos de una carpeta (recursivo). */
export async function folderSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(full);
    else if (entry.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}

/** El disco que contiene la carpeta, o `null` si el sistema no lo dice. */
export async function diskUsage(dir: string): Promise<DiskUsage | null> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const s = await fs.statfs(dir);
    return { usedBytes: (s.blocks - s.bfree) * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

async function removeFile(dir: string, relative: string): Promise<boolean> {
  const full = resolveMediaPath(dir, relative);
  if (!full) return true; // una ruta que no cabe en la carpeta no se toca: no hay nada que borrar
  try {
    await fs.rm(full, { force: true });
    return true;
  } catch (error) {
    console.error("[media] no se pudo borrar", relative, error instanceof Error ? error.message : error);
    return false;
  }
}

async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // la carpeta todavía no existe
  }
}

export type PurgeDeps = {
  index: MediaIndex;
  config: MediaConfig;
  now?: Date;
  /** Para pruebas: medir el disco de otro modo. */
  measureDisk?: (dir: string) => Promise<DiskUsage | null>;
};

export async function purgeMedia({ index, config, now = new Date(), measureDisk = diskUsage }: PurgeDeps): Promise<PurgeResult> {
  const rows = await index.listStored();
  const plan = planPurge({ rows, now, config, folderBytes: await folderSize(config.dir), disk: await measureDisk(config.dir) });

  const result: PurgeResult = { ttl: 0, space: 0, freedBytes: 0, foldersRemoved: 0 };
  for (const reason of ["ttl", "space"] as const) {
    const done: MediaRow[] = [];
    for (const row of plan[reason]) {
      // Primero el archivo; la fila se marca solo si ya no hay archivo.
      if (await removeFile(config.dir, row.path)) done.push(row);
    }
    if (done.length) await index.markExpired(done.map((r) => r.id), reason, now);
    result[reason] = done.length;
    result.freedBytes += done.reduce((sum, r) => sum + r.bytes, 0);
  }

  // Las carpetas de días anteriores al plazo caen enteras: todo lo que traen es más viejo que el tope,
  // así que también se va lo huérfano (un archivo que se escribió pero cuyo mensaje no se guardó).
  const oldestKept = dayFolder(new Date(now.getTime() - config.retentionDays * DAY_MS));
  for (const entry of await readDir(config.dir)) {
    if (entry.isDirectory() && isDayFolder(entry.name) && entry.name < oldestKept) {
      await fs.rm(path.join(config.dir, entry.name), { recursive: true, force: true });
      result.foldersRemoved += 1;
    }
  }
  // Y las carpetas de día que quedaron vacías.
  for (const entry of await readDir(config.dir)) {
    if (!entry.isDirectory() || !isDayFolder(entry.name)) continue;
    const full = path.join(config.dir, entry.name);
    if ((await readDir(full)).length === 0) await fs.rmdir(full).catch(() => {});
  }
  return result;
}
