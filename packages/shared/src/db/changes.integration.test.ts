import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq, inArray } from "drizzle-orm";
import { Client } from "pg";

import { closeTestDatabase, createConversation, integrationSkip, resetDatabase } from "./test-db";
import { CHANGES_CHANNEL } from "./changes";
import { db } from "./client";
import { messages } from "./schema";

/**
 * Los avisos en vivo de `messages` dicen de qué chats son (migración 0026,
 * H2 en docs/CAPACIDAD-CONVERSACIONES.md): así el portal no vuelve a pedir el
 * hilo abierto por un mensaje de otro chat.
 */
describe("avisos de messages con el chat (Postgres)", { skip: integrationSkip }, () => {
  let listener: Client;
  let received: string[] = [];

  before(async () => {
    listener = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await listener.connect();
    listener.on("notification", (msg) => {
      if (msg.channel === CHANGES_CHANNEL && msg.payload?.startsWith("messages")) received.push(msg.payload);
    });
    await listener.query(`LISTEN ${CHANGES_CHANNEL}`);
  });

  beforeEach(async () => {
    await resetDatabase();
    await settle();
    received = [];
  });

  after(async () => {
    await listener?.end();
    await closeTestDatabase();
  });

  /** Los avisos llegan al hacer COMMIT, por otra conexión: se espera un poco. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const ids = (payload: string) => payload.split(":")[1]?.split(",").map(Number).sort((a, b) => a - b) ?? null;

  it("un mensaje nuevo avisa con su chat", async () => {
    const chat = await createConversation();
    await db.insert(messages).values({ conversationId: chat.id, role: "restaurant", text: "hola" });
    await settle();
    assert.deepEqual(received, [`messages:${chat.id}`]);
  });

  it("varios chats en una sola sentencia: un aviso con todos", async () => {
    const a = await createConversation();
    const b = await createConversation();
    await db.insert(messages).values([
      { conversationId: a.id, role: "bot", text: "1" },
      { conversationId: b.id, role: "bot", text: "2" },
      { conversationId: a.id, role: "bot", text: "3" },
    ]);
    await settle();
    assert.equal(received.length, 1);
    assert.deepEqual(ids(received[0]), [a.id, b.id].sort((x, y) => x - y));
  });

  it("un mensaje que cambia (el «No se pudo entregar» de Meta) avisa con su chat", async () => {
    const chat = await createConversation();
    const [m] = await db.insert(messages).values({ conversationId: chat.id, role: "bot", text: "va Pedro" }).returning();
    await settle();
    received = [];
    await db.update(messages).set({ text: "va Pedro ⚠️" }).where(eq(messages.id, m.id));
    await settle();
    assert.deepEqual(received, [`messages:${chat.id}`]);
  });

  it("un UPDATE que no toca ninguna fila no avisa", async () => {
    await db.update(messages).set({ text: "x" }).where(eq(messages.id, 999_999));
    await settle();
    assert.deepEqual(received, []);
  });

  it("un borrado (la retención) avisa sin chat: el portal se pone al día entero", async () => {
    const chat = await createConversation();
    const rows = await db.insert(messages).values([{ conversationId: chat.id, role: "bot", text: "1" }]).returning();
    await settle();
    received = [];
    await db.delete(messages).where(inArray(messages.id, rows.map((r) => r.id)));
    await settle();
    assert.deepEqual(received, ["messages"]);
  });

  it("demasiados chats a la vez: un aviso sin chat, que no pase del límite de pg_notify", async () => {
    const chats = await Promise.all(Array.from({ length: 30 }, () => createConversation()));
    await settle();
    received = [];
    await db.insert(messages).values(chats.map((c) => ({ conversationId: c.id, role: "bot" as const, text: "aviso" })));
    await settle();
    assert.deepEqual(received, ["messages"]);
  });
});
