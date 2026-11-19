import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, createConversation, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import { getThread } from "@/db/queries/conversations";
import { installMocks, params, request, resetMocks, restoreMocks } from "@/test-support/portal-env";

/**
 * `GET /api/media/[id]`: la foto de un mensaje del chat, y cómo llega al hilo
 * (`getThread`): la foto vigente, la expirada (sin ruta de archivo) y el
 * mensaje sin foto. La puerta de la sesión es `proxy.ts`, que
 * `proxy.test.ts` comprueba para todas las rutas. Sin `TEST_DATABASE_URL` se salta.
 */

type Route = typeof import("./[id]/route");
let route: Route;
let dir: string;
const saved = { dir: process.env.MEDIA_DIR, days: process.env.MEDIA_RETENTION_DAYS };

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  route = await import("./[id]/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "portal-media-route-"));
  process.env.MEDIA_DIR = dir;
  process.env.MEDIA_RETENTION_DAYS = "30";
});

afterEach(async () => {
  for (const [key, value] of [["MEDIA_DIR", saved.dir], ["MEDIA_RETENTION_DAYS", saved.days]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

const get = (id: string | number) => route.GET(request("GET", `/api/media/${id}`), params({ id }));

async function photoMessage(over: Partial<typeof schema.messages.$inferInsert> = {}) {
  const chat = await createConversation();
  const relative = "2026-11-19/foto.webp";
  await fs.mkdir(path.join(dir, "2026-11-19"), { recursive: true });
  await fs.writeFile(path.join(dir, relative), Buffer.from("RIFF....WEBPfake"));
  const [row] = await db
    .insert(schema.messages)
    .values({ conversationId: chat.id, role: "restaurant", text: "[Imagen] El pedido", mediaPath: relative, mediaMime: "image/webp", mediaBytes: 16, mediaWidth: 1200, mediaHeight: 800, mediaStatus: "stored", ...over })
    .returning();
  return { chat, row };
}

after(async () => {
  if (integrationSkip) return;
  restoreMocks();
  await closeTestDatabase();
});

describe("GET /api/media/[id] (Postgres)", { skip: integrationSkip }, () => {
  it("sirve la foto con su tipo y un caché solo del navegador", async () => {
    const { row } = await photoMessage();
    const res = await get(row.id);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal(res.headers.get("cache-control"), "private, max-age=86400, immutable");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "RIFF....WEBPfake");
  });

  it("una foto expirada es un 404 (el chat ya muestra el aviso, no pide la imagen)", async () => {
    const { row } = await photoMessage({ mediaStatus: "expired", mediaExpiredReason: "ttl" });
    assert.equal((await get(row.id)).status, 404);
  });

  it("el archivo borrado a mano también da 404, no 500", async () => {
    const { row } = await photoMessage();
    await fs.rm(path.join(dir, "2026-11-19", "foto.webp"));
    assert.equal((await get(row.id)).status, 404);
  });

  it("un mensaje sin foto, uno que no existe o un id que no es un número: 404", async () => {
    const chat = await createConversation();
    const [plain] = await db.insert(schema.messages).values({ conversationId: chat.id, role: "bot", text: "hola" }).returning();
    for (const id of [plain.id, 99_999, "abc", "0", "-1", "1.5", "1e3"]) assert.equal((await get(id)).status, 404, String(id));
  });

  it("una ruta guardada que se sale de la carpeta no se sirve", async () => {
    const { row } = await photoMessage({ mediaPath: "../../etc/passwd" });
    assert.equal((await get(row.id)).status, 404);
  });
});

describe("getThread con fotos (Postgres)", { skip: integrationSkip }, () => {
  it("cada mensaje trae su foto: vigente con tamaño, expirada con motivo y plazo, o ninguna", async () => {
    const { chat, row: stored } = await photoMessage();
    await db.insert(schema.messages).values({ conversationId: chat.id, role: "restaurant", text: "[Imagen]", mediaPath: "2026-10-01/vieja.webp", mediaMime: "image/webp", mediaBytes: 9, mediaStatus: "expired", mediaExpiredReason: "ttl" });
    await db.insert(schema.messages).values({ conversationId: chat.id, role: "bot", text: "Recibido" });

    const thread = await getThread(chat.id);

    assert.deepEqual(thread[0].media, { status: "stored", mime: "image/webp", width: 1200, height: 800, bytes: 16 });
    assert.equal(thread[0].id, stored.id);
    assert.deepEqual(thread[1].media, { status: "expired", reason: "ttl", retentionDays: 30 });
    assert.equal(thread[2].media, null);
  });

  it("el hilo nunca lleva la ruta del archivo en el servidor", async () => {
    const { chat } = await photoMessage();
    assert.equal(JSON.stringify(await getThread(chat.id)).includes("foto.webp"), false);
  });
});
