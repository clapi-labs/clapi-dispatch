import { sql, type SQL } from "drizzle-orm";

import { retentionConfig, retentionCutoff, type RetentionConfig } from "../domain/retention";
import { db } from "./client";

/**
 * Borra lo que ya pasó su tiempo de retención (domain/retention.ts). Lo corre
 * el tick del bot (`/api/internal/tick`) una vez por hora; se puede llamar
 * seguido y en paralelo: cada pasada borra lo que encuentre.
 *
 * Se borra de a `BATCH` filas por sentencia, para no tener bloqueos largos ni
 * un único DELETE enorme el primer día; si queda algo después de
 * `MAX_BATCHES`, sigue en la próxima pasada. `trips` y `assignments` no se
 * tocan nunca.
 */

export const RETENTION_BATCH = 5000;
const MAX_BATCHES = 40;

export type RetentionResult = { processedMessages: number; engineEvaluations: number; messages: number };

async function deleteInBatches(deleteOne: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const deleted = await deleteOne();
    total += deleted;
    if (deleted < RETENTION_BATCH) break;
  }
  return total;
}

type Count = { n: number };

async function count(query: SQL): Promise<number> {
  const { rows } = await db.execute<Count>(sql`with deleted as (${query} returning 1) select count(*)::int as n from deleted`);
  return rows[0]?.n ?? 0;
}

export async function runRetention(now = new Date(), config: RetentionConfig = retentionConfig()): Promise<RetentionResult> {
  const result: RetentionResult = { processedMessages: 0, engineEvaluations: 0, messages: 0 };

  if (config.processedMessagesDays !== null) {
    const cutoff = retentionCutoff(config.processedMessagesDays, now);
    result.processedMessages = await deleteInBatches(() =>
      count(sql`delete from processed_messages where wa_message_id in (
        select wa_message_id from processed_messages where processed_at < ${cutoff} limit ${RETENTION_BATCH})`),
    );
  }

  if (config.engineEvaluationsDays !== null) {
    // Las que siguen esperando moto no se tocan, por viejas que sean: el
    // engine todavía las usa.
    const cutoff = retentionCutoff(config.engineEvaluationsDays, now);
    result.engineEvaluations = await deleteInBatches(() =>
      count(sql`delete from engine_evaluations where id in (
        select id from engine_evaluations
        where updated_at < ${cutoff} and status <> 'waiting'
        order by id limit ${RETENTION_BATCH})`),
    );
  }

  if (config.messagesDays !== null) {
    // Por id: los más viejos son los de id más bajo, así que el recorrido por
    // la llave primaria se detiene en cuanto llena el lote.
    const cutoff = retentionCutoff(config.messagesDays, now);
    result.messages = await deleteInBatches(() =>
      count(sql`delete from messages where id in (
        select id from messages where created_at < ${cutoff} order by id limit ${RETENTION_BATCH})`),
    );
  }

  return result;
}
