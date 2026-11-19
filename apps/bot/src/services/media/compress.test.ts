import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { compressImage, ImageRejected, MAX_INPUT_BYTES, MAX_INPUT_PIXELS, MAX_SIDE_PX } from "./compress";

/** Una foto «real»: ruido, que no comprime tanto como un color liso. */
async function photo(width: number, height: number, format: "jpeg" | "png" | "webp" = "jpeg") {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i / 3) | 0) * 13) % 256;
  return sharp(raw, { raw: { width, height, channels } })
    .toFormat(format, format === "png" ? {} : { quality: 92 })
    .toBuffer();
}

const rejection = async (input: Buffer) => {
  try {
    await compressImage(input);
  } catch (error) {
    assert.ok(error instanceof ImageRejected, `se esperaba ImageRejected y salió ${String(error)}`);
    return error.reason;
  }
  assert.fail("se esperaba que la rechazara");
};

describe("compressImage", () => {
  it("una foto grande se achica a 1.200 px de lado mayor, en WebP", async () => {
    const out = await compressImage(await photo(3000, 2000));
    assert.equal(out.mime, "image/webp");
    assert.equal(out.ext, "webp");
    assert.deepEqual([out.width, out.height], [1200, 800], "se conserva la proporción");
    const meta = await sharp(out.bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 1200, 800]);
  });

  it("una foto vertical se limita por su alto", async () => {
    const out = await compressImage(await photo(1500, 3000));
    assert.deepEqual([out.width, out.height], [600, 1200]);
  });

  it("una foto chica no se agranda", async () => {
    const out = await compressImage(await photo(400, 300));
    assert.deepEqual([out.width, out.height], [400, 300]);
  });

  it("pesa mucho menos que la original", async () => {
    const input = await photo(3000, 2000);
    const out = await compressImage(input);
    assert.ok(out.bytes.length < input.length / 2, `${out.bytes.length} de ${input.length}`);
  });

  it("acepta JPEG, PNG y WebP", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const out = await compressImage(await photo(800, 600, format));
      assert.equal(out.mime, "image/webp", format);
    }
  });

  it("aplica la orientación del EXIF (una foto de celular acostada se endereza) y no deja metadatos", async () => {
    const sideways = await sharp(await photo(800, 400)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    assert.equal((await sharp(sideways).metadata()).orientation, 6);
    const out = await compressImage(sideways);
    assert.deepEqual([out.width, out.height], [400, 800], "girada: lo ancho pasó a alto");
    const meta = await sharp(out.bytes).metadata();
    assert.equal(meta.exif, undefined, "sin EXIF");
  });

  it("una imagen con transparencia sigue funcionando", async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    assert.equal((await compressImage(png)).width, 300);
  });
});

describe("compressImage — lo que rechaza", () => {
  it("más de 5 MB de entrada", async () => {
    assert.equal(await rejection(Buffer.alloc(MAX_INPUT_BYTES + 1, 1)), "too_large");
  });

  it("justo 5 MB de entrada no se rechaza por peso (se juzga por su contenido)", async () => {
    assert.equal(await rejection(Buffer.alloc(MAX_INPUT_BYTES, 1)), "not_an_image");
  });

  it("vacío", async () => {
    assert.equal(await rejection(Buffer.alloc(0)), "not_an_image");
  });

  it("texto o bytes que no son una imagen, aunque Meta diga image/jpeg", async () => {
    assert.equal(await rejection(Buffer.from("esto no es una foto")), "not_an_image");
    assert.equal(await rejection(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])), "not_an_image", "cabecera JPEG sin imagen");
  });

  it("un JPEG cortado a la mitad no entra", async () => {
    const full = await photo(1200, 900);
    const reason = await rejection(full.subarray(0, Math.floor(full.length / 2)));
    assert.ok(reason === "not_an_image", reason);
  });

  it("formatos que no sirven: SVG, GIF, PDF", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    assert.ok(["unsupported_format", "not_an_image"].includes(await rejection(svg)));
    const gif = await sharp(await photo(50, 50)).gif().toBuffer();
    assert.equal(await rejection(gif), "unsupported_format");
    assert.equal(await rejection(Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")), "not_an_image");
  });

  it("una imagen con demasiados píxeles (bomba de descompresión) no se abre", async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 100;
    const huge = await sharp({ create: { width: side, height: side, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer();
    assert.ok(huge.length < MAX_INPUT_BYTES, `el PNG pesa ${huge.length}: tiene que caber en los 5 MB para probar el tope de píxeles`);
    assert.equal(await rejection(huge), "too_many_pixels");
  });

  it("el lado máximo configurado es 1.200", () => {
    assert.equal(MAX_SIDE_PX, 1200);
  });
});
