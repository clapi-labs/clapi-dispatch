import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { mediaConfig, relativeMediaPath, resolveMediaPath } from "@dispatch/shared/media";

import { fetchMedia, type MediaFile } from "@/services/whatsapp/client";

import { compressImage, ImageRejected, type CompressedImage } from "./compress";
import { Limiter } from "./limiter";

/**
 * Guarda en el disco del servidor las fotos que llegan a los chats. En la base
 * solo queda la referencia (`messages.media_*`); los bytes viven en la carpeta
 * de fotos, una por día: `<MEDIA_DIR>/AAAA-MM-DD/<uuid>.webp`. La limpieza
 * (`purgeOldMedia`) las borra con el tiempo y por espacio.
 */

/** Lo que se guarda en la fila del mensaje. */
export type StoredMedia = { path: string; mime: string; bytes: number; width: number; height: number };

export type StoreDeps = {
  fetchMedia: (mediaId: string) => Promise<MediaFile | null>;
  compress: (input: Buffer) => Promise<CompressedImage>;
  dir: string;
  now: () => Date;
  newId: () => string;
  limiter: Limiter;
};

let defaultLimiter: Limiter | null = null;

/** De a cuántas fotos se procesan a la vez (`MEDIA_CONCURRENCY`, 2 por defecto). */
function sharedLimiter(): Limiter {
  if (!defaultLimiter) {
    const asked = Math.floor(Number(process.env.MEDIA_CONCURRENCY));
    defaultLimiter = new Limiter(asked >= 1 ? Math.min(asked, 8) : 2);
  }
  return defaultLimiter;
}

function defaults(): StoreDeps {
  return { fetchMedia, compress: compressImage, dir: mediaConfig().dir, now: () => new Date(), newId: randomUUID, limiter: sharedLimiter() };
}

/** Escribe el archivo entero o nada: primero uno temporal y luego se renombra. */
async function writeAtomic(full: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  try {
    await fs.writeFile(tmp, bytes, { flag: "wx" });
    await fs.rename(tmp, full);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Descarga la foto de Meta, la achica y la guarda. Nunca lanza: si algo falla
 * (Meta no responde, pesa de más, no es una imagen, el disco no deja escribir)
 * devuelve `null` y el mensaje queda solo con su texto, como antes.
 */
export async function storeIncomingImage(mediaId: string, overrides: Partial<StoreDeps> = {}): Promise<StoredMedia | null> {
  const deps = { ...defaults(), ...overrides };
  try {
    return await deps.limiter.run(async () => {
      const file = await deps.fetchMedia(mediaId);
      if (!file) return null;

      let image: CompressedImage;
      try {
        image = await deps.compress(file.bytes);
      } catch (error) {
        if (error instanceof ImageRejected) {
          console.warn(`[media] imagen descartada (${error.reason}):`, mediaId);
          return null;
        }
        throw error;
      }

      const relative = relativeMediaPath(deps.now(), deps.newId(), image.ext);
      const full = resolveMediaPath(deps.dir, relative);
      if (!full) throw new Error(`ruta fuera de la carpeta de fotos: ${relative}`);
      await writeAtomic(full, image.bytes);
      return { path: relative, mime: image.mime, bytes: image.bytes.length, width: image.width, height: image.height };
    });
  } catch (error) {
    console.error("[media] no se pudo guardar la imagen", mediaId, error instanceof Error ? error.message : error);
    return null;
  }
}
