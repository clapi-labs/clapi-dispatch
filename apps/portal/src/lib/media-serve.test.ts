import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { serveMedia, type MediaRef } from "./media-serve";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "portal-media-"));
  await fs.mkdir(path.join(dir, "2026-11-19"), { recursive: true });
  await fs.writeFile(path.join(dir, "2026-11-19", "a.webp"), Buffer.from("RIFF....WEBPfake"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const stored = (over: Partial<MediaRef> = {}): MediaRef => ({ mediaPath: "2026-11-19/a.webp", mediaMime: "image/webp", mediaStatus: "stored", ...over });

describe("serveMedia", () => {
  it("sirve la foto con su tipo, su largo y un caché solo del navegador", async () => {
    const res = await serveMedia(stored(), dir);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal(res.headers.get("content-length"), "16");
    assert.equal(res.headers.get("cache-control"), "private, max-age=86400, immutable");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-disposition"), "inline");
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "RIFF....WEBPfake");
  });

  it("un tipo que no es de imagen no se anuncia como tal", async () => {
    const res = await serveMedia(stored({ mediaMime: "text/html" }), dir);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("una foto expirada (la limpieza ya la borró) es un 404 sin caché", async () => {
    const res = await serveMedia(stored({ mediaStatus: "expired" }), dir);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { error: "Imagen no disponible" });
  });

  it("el archivo que desapareció entre tanto también es un 404, no un 500", async () => {
    await fs.rm(path.join(dir, "2026-11-19", "a.webp"));
    assert.equal((await serveMedia(stored(), dir)).status, 404);
  });

  it("un mensaje que no existe, sin foto o sin ruta: 404", async () => {
    assert.equal((await serveMedia(undefined, dir)).status, 404);
    assert.equal((await serveMedia(null, dir)).status, 404);
    assert.equal((await serveMedia(stored({ mediaStatus: null }), dir)).status, 404);
    assert.equal((await serveMedia(stored({ mediaPath: null }), dir)).status, 404);
  });

  it("una ruta guardada que se sale de la carpeta nunca se lee", async () => {
    const outside = path.join(path.dirname(dir), `fuera-${path.basename(dir)}.webp`);
    await fs.writeFile(outside, "secreto");
    try {
      for (const bad of [`../${path.basename(outside)}`, outside, "2026-11-19/../../etc/passwd"]) {
        assert.equal((await serveMedia(stored({ mediaPath: bad }), dir)).status, 404, bad);
      }
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("una carpeta en lugar del archivo: 404", async () => {
    await fs.mkdir(path.join(dir, "2026-11-19", "carpeta.webp"));
    assert.equal((await serveMedia(stored({ mediaPath: "2026-11-19/carpeta.webp" }), dir)).status, 404);
  });
});
