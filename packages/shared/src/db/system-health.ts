import { readFile, readdir, stat, statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { retentionConfig, type RetentionConfig } from "../domain/retention";
import { diskLevel, diskUsageFromStatfs, type DiskLevel, type DiskUsage } from "../domain/system-health";
import { db } from "./client";

/**
 * Lo que muestra la tarjeta «Salud del sistema» del portal (/salud) y lo que
 * mira la alerta de disco del tick (`diskFull` en db/push.ts).
 *
 * Dentro de Docker, el disco de `/` es el del servidor (las capas del
 * contenedor viven ahí); `HEALTH_DISK_PATH` cambia qué ruta se mide. La
 * memoria es la del contenedor que pregunta (cgroup) y la de la máquina.
 *
 * Las rutas van con `turbopackIgnore`: se leen en el servidor y Next no debe
 * incluir el proyecto entero en la imagen por ellas.
 */

/** El disco donde vive la base y las imágenes. */
export async function diskUsage(path = process.env.HEALTH_DISK_PATH || "/"): Promise<DiskUsage> {
  return diskUsageFromStatfs(path, await statfs(/*turbopackIgnore: true*/ path));
}

export type MediaUsage = { dir: string | null; exists: boolean; bytes: number; files: number; oldest: string | null; truncated: boolean };

const MEDIA_MAX_FILES = 200_000;

/** La carpeta de imágenes de los chats (`MEDIA_DIR`, issue #102). Mientras no
 *  exista, sale vacía. Se recorre entera: hasta `MEDIA_MAX_FILES` archivos. */
export async function mediaUsage(dir = process.env.MEDIA_DIR || null): Promise<MediaUsage> {
  const usage: MediaUsage = { dir, exists: false, bytes: 0, files: 0, oldest: null, truncated: false };
  if (!dir) return usage;
  try {
    if (!(await stat(/*turbopackIgnore: true*/ dir)).isDirectory()) return usage;
  } catch {
    return usage;
  }
  usage.exists = true;
  let oldest = Infinity;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(/*turbopackIgnore: true*/ current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(/*turbopackIgnore: true*/ current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (usage.files >= MEDIA_MAX_FILES) {
        usage.truncated = true;
        pending.length = 0;
        break;
      }
      try {
        const s = await stat(/*turbopackIgnore: true*/ path);
        usage.bytes += s.size;
        usage.files++;
        if (s.mtimeMs < oldest) oldest = s.mtimeMs;
      } catch {
        // Se borró mientras se recorría.
      }
    }
  }
  usage.oldest = Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
  return usage;
}

export type TableSize = { name: string; bytes: number; rows: number };
export type DatabaseUsage = { bytes: number; tables: TableSize[] };

/** El peso de la base y de sus tablas más grandes (con índices y TOAST). Las
 *  filas son el estimado de Postgres (`reltuples`): no recorre las tablas. */
export async function databaseUsage(limit = 10): Promise<DatabaseUsage> {
  const [size, tables] = await Promise.all([
    db.execute<{ bytes: string }>(sql`select pg_database_size(current_database())::text as bytes`),
    db.execute<{ name: string; bytes: string; rows: string }>(sql`
      select c.relname as name, pg_total_relation_size(c.oid)::text as bytes, greatest(c.reltuples, 0)::bigint::text as rows
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname = 'public'
      order by pg_total_relation_size(c.oid) desc
      limit ${limit}`),
  ]);
  return {
    bytes: Number(size.rows[0]?.bytes ?? 0),
    tables: tables.rows.map((t) => ({ name: t.name, bytes: Number(t.bytes), rows: Number(t.rows) })),
  };
}

export type MemoryUsage = {
  /** Lo que ocupa este proceso (el portal). */
  processRss: number;
  /** El contenedor, si se puede leer su cgroup; `limit` es null sin límite. */
  container: { used: number; limit: number | null } | null;
  /** La máquina entera. */
  system: { total: number; free: number };
};

async function readNumber(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

export async function memoryUsage(): Promise<MemoryUsage> {
  // cgroup v2 (Docker reciente); fuera de un contenedor no existe.
  const used = await readNumber("/sys/fs/cgroup/memory.current");
  const limit = await readNumber("/sys/fs/cgroup/memory.max");
  return {
    processRss: process.memoryUsage().rss,
    container: used === null ? null : { used, limit },
    system: { total: totalmem(), free: freemem() },
  };
}

export type SystemHealth = {
  at: string;
  disk: (DiskUsage & { level: DiskLevel }) | null;
  media: MediaUsage;
  database: DatabaseUsage | null;
  memory: MemoryUsage;
  retention: RetentionConfig;
  /** Lo que no se pudo medir, para mostrarlo en vez de esconderlo. */
  errors: string[];
};

export async function systemHealth(): Promise<SystemHealth> {
  const errors: string[] = [];
  const [disk, media, database, memory] = await Promise.all([
    diskUsage().then(
      (d) => ({ ...d, level: diskLevel(d.usedPct) }),
      (error: unknown) => {
        errors.push(`disco: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      },
    ),
    mediaUsage(),
    databaseUsage().catch((error: unknown) => {
      errors.push(`base de datos: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
    memoryUsage(),
  ]);
  return { at: new Date().toISOString(), disk, media, database, memory, retention: retentionConfig(), errors };
}
