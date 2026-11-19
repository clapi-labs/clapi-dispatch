import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "./client";
import { mediaIndex, purgeOldMedia } from "./media-retention";
import { messages } from "./schema";
import { closeTestDatabase, createConversation, integrationSkip, resetDatabase } from "./test-db";

/**
 * La limpieza de las fotos contra Postgres de verdad: las filas con foto en
 * disco, el borrado de los archivos y el marcado como `expired`. La decisión
 * (qué borrar y en qué orden) se prueba aparte, sin base, en
 * `media/media.test.ts`. Sin `TEST_DATABASE_URL` se salta.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-11-19T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

let dir: string;
const saved = { ...process.env };

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "retention-test-"));
  process.env.MEDIA_DIR = dir;
  process.env.MEDIA_RETENTION_DAYS = "30";
  process.env.MEDIA_MAX_MB = "3072";
  process.env.MEDIA_MAX_DISK_PERCENT = "100"; // el disco real de quien corre la prueba no debe influir
});

afterEach(async () => {
  for (const key of ["MEDIA_DIR", "MEDIA_RETENTION_DAYS", "MEDIA_MAX_MB", "MEDIA_MAX_DISK_PERCENT"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

/** Un mensaje con foto en disco, de hace `ageDays` días. */
async function photo(conversationId: number, ageDays: number, bytes = 2_000) {
  const createdAt = daysAgo(ageDays);
  const relative = `${createdAt.toISOString().slice(0, 10)}/${ageDays}-${Math.random().toString(36).slice(2)}.webp`;
  await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
  await fs.writeFile(path.join(dir, relative), Buffer.alloc(bytes, 7));
  const [row] = await db
    .insert(messages)
    .values({ conversationId, role: "restaurant", text: "[Imagen]", createdAt, mediaPath: relative, mediaMime: "image/webp", mediaBytes: bytes, mediaWidth: 100, mediaHeight: 80, mediaStatus: "stored" })
    .returning();
  return { row, relative };
}

const exists = (relative: string) => fs.stat(path.join(dir, relative)).then(() => true, () => false);
const statusOf = async (id: number) => (await db.select().from(messages).where(eq(messages.id, id)))[0];

describe("limpieza de fotos (Postgres)", { skip: integrationSkip }, () => {
  after(closeTestDatabase);

  it("listStored devuelve solo las fotos que siguen en disco, sin los mensajes de texto", async () => {
    const chat = await createConversation();
    await photo(chat.id, 1);
    await db.insert(messages).values({ conversationId: chat.id, role: "bot", text: "hola" });
    const expired = await photo(chat.id, 2);
    await db.update(messages).set({ mediaStatus: "expired" }).where(eq(messages.id, expired.row.id));

    const listed = await mediaIndex.listStored();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].bytes, 2_000);
  });

  it("borra el archivo de lo que pasó de 30 días y marca la fila como expirada por tiempo; lo reciente queda", async () => {
    const chat = await createConversation();
    const old = await photo(chat.id, 45);
    const recent = await photo(chat.id, 3);

    const result = await purgeOldMedia(NOW);

    assert.deepEqual([result.ttl, result.space], [1, 0]);
    assert.equal(await exists(old.relative), false);
    assert.equal(await exists(recent.relative), true);
    const oldRow = await statusOf(old.row.id);
    assert.deepEqual([oldRow.mediaStatus, oldRow.mediaExpiredReason], ["expired", "ttl"]);
    assert.ok(oldRow.mediaExpiredAt);
    assert.equal(oldRow.text, "[Imagen]", "el mensaje sigue en el hilo");
    assert.equal(oldRow.mediaPath, old.row.mediaPath, "la referencia no se pierde: es el rastro de que hubo una foto");
    assert.equal((await statusOf(recent.row.id)).mediaStatus, "stored");
  });

  it("respeta MEDIA_RETENTION_DAYS", async () => {
    process.env.MEDIA_RETENTION_DAYS = "7";
    const chat = await createConversation();
    const tenDays = await photo(chat.id, 10);
    const fiveDays = await photo(chat.id, 5);
    await purgeOldMedia(NOW);
    assert.equal((await statusOf(tenDays.row.id)).mediaStatus, "expired");
    assert.equal((await statusOf(fiveDays.row.id)).mediaStatus, "stored");
  });

  it("respeta el tope de espacio: borra las más viejas y las marca por espacio", async () => {
    process.env.MEDIA_MAX_MB = "0.005"; // ≈ 5.242 bytes
    const chat = await createConversation();
    const a = await photo(chat.id, 10, 2_000);
    const b = await photo(chat.id, 6, 2_000);
    const c = await photo(chat.id, 2, 2_000);

    const result = await purgeOldMedia(NOW);

    assert.deepEqual([result.ttl, result.space], [0, 1], "6.000 bytes con tope de ≈5.242: sale solo la más vieja");
    assert.equal(await exists(a.relative), false);
    assert.equal(await exists(b.relative), true);
    assert.equal(await exists(c.relative), true);
    const row = await statusOf(a.row.id);
    assert.deepEqual([row.mediaStatus, row.mediaExpiredReason], ["expired", "space"]);
  });

  it("una segunda pasada no vuelve a tocar lo ya expirado", async () => {
    const chat = await createConversation();
    const old = await photo(chat.id, 45);
    await purgeOldMedia(NOW);
    const first = (await statusOf(old.row.id)).mediaExpiredAt;
    const again = await purgeOldMedia(new Date(NOW.getTime() + 3600_000));
    assert.deepEqual([again.ttl, again.space], [0, 0]);
    assert.deepEqual((await statusOf(old.row.id)).mediaExpiredAt, first);
  });

  it("la base no guarda bytes de imagen: la fila solo lleva la referencia", async () => {
    const chat = await createConversation();
    const { row } = await photo(chat.id, 1, 50_000);
    assert.ok(JSON.stringify(row).length < 1_000, "la fila pesa lo de unos metadatos, no lo de la foto");
  });
});
