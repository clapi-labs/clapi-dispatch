import { promises as fs } from "node:fs";

import { resolveMediaPath } from "@dispatch/shared/media";

/**
 * Sirve una foto del chat. La ruta sale de la base (nunca de la petición) y se
 * comprueba que no se salga de la carpeta de fotos. Una foto que ya no está
 * (expiró, o el archivo se borró entre tanto) es un 404 sin más: el portal ya
 * sabe por el estado del mensaje que debe mostrar «imagen expirada», y si el
 * archivo desapareció justo ahora, el visor cae al mismo aviso.
 */

export type MediaRef = { mediaPath: string | null; mediaMime: string | null; mediaStatus: "stored" | "expired" | null };

const SERVED_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

const notFound = () => Response.json({ error: "Imagen no disponible" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function serveMedia(ref: MediaRef | null | undefined, dir: string): Promise<Response> {
  if (!ref || ref.mediaStatus !== "stored" || !ref.mediaPath) return notFound();
  const full = resolveMediaPath(dir, ref.mediaPath);
  if (!full) return notFound();

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(full);
  } catch {
    return notFound();
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": ref.mediaMime && SERVED_TYPES.has(ref.mediaMime) ? ref.mediaMime : "application/octet-stream",
      "Content-Length": String(bytes.length),
      // La foto de un mensaje no cambia: el navegador la guarda un día (solo él, no un caché compartido).
      "Cache-Control": "private, max-age=86400, immutable",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      // Es una imagen: no necesita ejecutar nada si alguien abre la dirección directamente.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
