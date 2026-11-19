import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { sql } from "drizzle-orm";

import { closeTestDatabase, createConversation, createTrip, integrationSkip, resetDatabase } from "./test-db";
import { db } from "./client";
import { RETENTION_BATCH, runRetention } from "./retention";
import { assignments, engineEvaluations, messages, processedMessages, trips } from "./schema";

/**
 * La retención automática (issue #103) contra Postgres de verdad: borra solo lo
 * que pasó su tiempo, nunca viajes ni asignaciones, y respeta lo apagado.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-19T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const CONFIG = { processedMessagesDays: 14, engineEvaluationsDays: 30, messagesDays: 365 };

const count = async (table: typeof messages | typeof processedMessages | typeof engineEvaluations | typeof trips | typeof assignments) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;

describe("runRetention (Postgres)", { skip: integrationSkip }, () => {
  beforeEach(resetDatabase);
  after(closeTestDatabase);

  it("webhooks atendidos: se van los de más de 14 días", async () => {
    await db.insert(processedMessages).values([
      { waMessageId: "wamid.viejo", processedAt: daysAgo(15) },
      { waMessageId: "wamid.limite", processedAt: daysAgo(13) },
      { waMessageId: "wamid.nuevo", processedAt: daysAgo(0) },
    ]);
    const result = await runRetention(NOW, CONFIG);
    assert.equal(result.processedMessages, 1);
    const left = (await db.select({ id: processedMessages.waMessageId }).from(processedMessages)).map((r) => r.id).sort();
    assert.deepEqual(left, ["wamid.limite", "wamid.nuevo"]);
  });

  it("evaluaciones del engine: se van las decididas o vencidas de más de 30 días; las que esperan moto, nunca", async () => {
    const trip = await createTrip();
    await db.insert(engineEvaluations).values([
      { tripId: trip.id, status: "decided", updatedAt: daysAgo(31), request: { motos: [] } },
      { tripId: trip.id, status: "expired", updatedAt: daysAgo(40) },
      { tripId: trip.id, status: "waiting", updatedAt: daysAgo(90) },
      { tripId: trip.id, status: "decided", updatedAt: daysAgo(5) },
    ]);
    const result = await runRetention(NOW, CONFIG);
    assert.equal(result.engineEvaluations, 2);
    const left = await db.select({ status: engineEvaluations.status }).from(engineEvaluations);
    assert.deepEqual(left.map((r) => r.status).sort(), ["decided", "waiting"]);
  });

  it("mensajes: se van los de más de un año; el chat y sus viajes se quedan", async () => {
    const chat = await createConversation();
    const trip = await createTrip({ conversationId: chat.id, createdAt: daysAgo(400) });
    await db.insert(messages).values([
      { conversationId: chat.id, role: "restaurant", text: "viejo", createdAt: daysAgo(400) },
      { conversationId: chat.id, role: "bot", text: "también viejo", createdAt: daysAgo(366), tripId: trip.id },
      { conversationId: chat.id, role: "restaurant", text: "de este año", createdAt: daysAgo(200) },
    ]);
    const result = await runRetention(NOW, CONFIG);
    assert.equal(result.messages, 2);
    assert.deepEqual((await db.select({ text: messages.text }).from(messages)).map((m) => m.text), ["de este año"]);
    assert.equal(await count(trips), 1, "los viajes no se tocan nunca");
  });

  it("con la retención apagada (null) esa tabla no se toca", async () => {
    const chat = await createConversation();
    await db.insert(messages).values({ conversationId: chat.id, role: "restaurant", text: "viejo", createdAt: daysAgo(4000) });
    await db.insert(processedMessages).values({ waMessageId: "wamid.viejo", processedAt: daysAgo(400) });
    const result = await runRetention(NOW, { processedMessagesDays: null, engineEvaluationsDays: null, messagesDays: null });
    assert.deepEqual(result, { processedMessages: 0, engineEvaluations: 0, messages: 0 });
    assert.equal(await count(messages), 1);
    assert.equal(await count(processedMessages), 1);
  });

  it("borra de a lotes y llega hasta el final", async () => {
    const total = RETENTION_BATCH + 123;
    await db.execute(sql`insert into processed_messages (wa_message_id, processed_at)
      select 'wamid.' || g, ${daysAgo(20)} from generate_series(1, ${total}) g`);
    const result = await runRetention(NOW, CONFIG);
    assert.equal(result.processedMessages, total);
    assert.equal(await count(processedMessages), 0);
  });

  it("se puede correr seguido: la segunda pasada no encuentra nada", async () => {
    await db.insert(processedMessages).values({ waMessageId: "wamid.viejo", processedAt: daysAgo(20) });
    await runRetention(NOW, CONFIG);
    assert.deepEqual(await runRetention(NOW, CONFIG), { processedMessages: 0, engineEvaluations: 0, messages: 0 });
  });
});
