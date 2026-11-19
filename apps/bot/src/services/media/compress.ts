import sharp from "sharp";

/**
 * Las fotos que llegan por WhatsApp se achican antes de guardarse: lado mayor
 * de 1.200 px como máximo y WebP con calidad ~70, que deja la mayoría en
 * 40–120 kB. Se aplica la orientación del EXIF y se descarta el resto de los
 * metadatos (ubicación, cámara), así que lo guardado no lleva datos de más.
 *
 * Antes de procesar se valida: peso de entrada, que de verdad sea una imagen
 * (se mira el contenido, no el tipo que dice Meta) y que sea un formato que
 * sirve (JPEG, PNG o WebP; nada de SVG, GIF ni PDF).
 */

export const MAX_SIDE_PX = 1200;
export const WEBP_QUALITY = 70;
export const MAX_INPUT_BYTES = 5 * 1024 * 1024;
/** Una imagen que descomprimida pasa de esto no se abre (bomba de descompresión). */
export const MAX_INPUT_PIXELS = 40_000_000;

const ACCEPTED = new Set(["jpeg", "png", "webp"]);

// Pocas conexiones de memoria y de hilos: el bot comparte 768 MB con todo lo demás.
sharp.cache(false);
sharp.concurrency(1);

export type RejectReason = "too_large" | "not_an_image" | "unsupported_format" | "too_many_pixels";

export class ImageRejected extends Error {
  constructor(readonly reason: RejectReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ImageRejected";
  }
}

export type CompressedImage = {
  bytes: Buffer;
  mime: "image/webp";
  ext: "webp";
  width: number;
  height: number;
};

export async function compressImage(input: Buffer): Promise<CompressedImage> {
  if (input.length === 0) throw new ImageRejected("not_an_image", "vacía");
  if (input.length > MAX_INPUT_BYTES) throw new ImageRejected("too_large", `${input.length} bytes`);

  let format: string | undefined;
  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    format = meta.format;
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch (error) {
    throw classify(error);
  }
  if (!format || !ACCEPTED.has(format)) throw new ImageRejected("unsupported_format", format ?? "desconocido");
  if (width <= 0 || height <= 0) throw new ImageRejected("not_an_image", "sin tamaño");
  if (width * height > MAX_INPUT_PIXELS) throw new ImageRejected("too_many_pixels", `${width}x${height}`);

  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, mime: "image/webp", ext: "webp", width: info.width, height: info.height };
  } catch (error) {
    throw classify(error);
  }
}

function classify(error: unknown): ImageRejected {
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit|exceeds pixel/i.test(message)) return new ImageRejected("too_many_pixels", message);
  return new ImageRejected("not_an_image", message);
}
