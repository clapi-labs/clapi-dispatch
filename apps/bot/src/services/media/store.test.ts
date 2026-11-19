import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import sharp from "sharp";

import { compressImage } from "./compress";
import { Limiter } from "./limiter";
import { storeIncomingImage, type StoreDeps } from "./store";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "bot-media-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const jpeg = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();

function deps(overrides: Partial<StoreDeps> = {}): Partial<StoreDeps> {
  return {
    dir,
    now: () => new Date("2026-11-19T15:00:00Z"),
    newId: () => "id-1",
    limiter: new Limiter(2),
    compress: compressImage,
    fetchMedia: async () => ({ mimeType: "image/jpeg", bytes: await jpeg(2400, 1600) }),
    ...overrides,
  };
}

/** Silencia el log de lo que se descarta a propósito. */
async function quiet<T>(fn: () => Promise<T>) {
  const [warn, error] = [console.warn, console.error];
  console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.warn, console.error] = [warn, error];
  }
}

describe("storeIncomingImage", () => {
  it("descarga, achica y guarda en AAAA-MM-DD/<uuid>.webp; devuelve solo la referencia", async () => {
    const stored = await storeIncomingImage("media-1", deps());

    assert.ok(stored);
    assert.equal(stored.path, "2026-11-19/id-1.webp");
    assert.equal(stored.mime, "image/webp");
    assert.deepEqual([stored.width, stored.height], [1200, 800]);
    const onDisk = await fs.readFile(path.join(dir, stored.path));
    assert.equal(onDisk.length, stored.bytes, "el peso guardado es el del archivo");
    assert.equal((await sharp(onDisk).metadata()).format, "webp");
  });

  it("no deja archivos temporales", async () => {
    await storeIncomingImage("media-1", deps());
    assert.deepEqual(await fs.readdir(path.join(dir, "2026-11-19")), ["id-1.webp"]);
  });

  it("organiza por día: otro día, otra carpeta", async () => {
    await storeIncomingImage("a", deps({ now: () => new Date("2026-11-19T15:00:00Z"), newId: () => "uno" }));
    await storeIncomingImage("b", deps({ now: () => new Date("2026-11-20T01:00:00Z"), newId: () => "dos" }));
    assert.deepEqual((await fs.readdir(dir)).sort(), ["2026-11-19", "2026-11-20"]);
  });

  it("le pide a Meta el archivo por su id", async () => {
    const asked: string[] = [];
    await storeIncomingImage("wamid-media-7", deps({ fetchMedia: async (id) => (asked.push(id), { mimeType: "image/jpeg", bytes: await jpeg(100, 100) }) }));
    assert.deepEqual(asked, ["wamid-media-7"]);
  });

  it("si Meta no entrega el archivo: null y nada en disco", async () => {
    assert.equal(await storeIncomingImage("x", deps({ fetchMedia: async () => null })), null);
    assert.deepEqual(await fs.readdir(dir), []);
  });

  it("lo que no es una imagen o pesa de más se descarta sin lanzar error", async () => {
    const result = await quiet(() => storeIncomingImage("x", deps({ fetchMedia: async () => ({ mimeType: "image/jpeg", bytes: Buffer.from("no soy una foto") }) })));
    assert.equal(result, null);
    assert.deepEqual(await fs.readdir(dir), []);
  });

  it("si el disco no deja escribir: null, sin lanzar", async () => {
    const blocker = path.join(dir, "es-un-archivo");
    await fs.writeFile(blocker, "x");
    const result = await quiet(() => storeIncomingImage("x", deps({ dir: blocker })));
    assert.equal(result, null);
  });

  it("si falla el procesamiento por un error inesperado: null, sin lanzar", async () => {
    const result = await quiet(() => storeIncomingImage("x", deps({ compress: async () => Promise.reject(new Error("sharp se cayó")) })));
    assert.equal(result, null);
  });

  it("varias fotos a la vez se procesan con el tope de concurrencia", async () => {
    let concurrent = 0;
    let peak = 0;
    const slowFetch: StoreDeps["fetchMedia"] = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 15));
      concurrent -= 1;
      return { mimeType: "image/jpeg", bytes: await jpeg(200, 200) };
    };
    let n = 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => storeIncomingImage("x", deps({ fetchMedia: slowFetch, limiter: shared, newId: () => `id-${++n}` }))),
    );
    assert.equal(results.filter(Boolean).length, 6);
    assert.ok(peak <= 2, `pico de ${peak} descargas a la vez, con tope de 2`);
    assert.equal(new Set(results.map((r) => r!.path)).size, 6, "cada foto, su archivo");
  });
});

const shared = new Limiter(2);
