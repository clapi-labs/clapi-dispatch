import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RETENTION_DEFAULTS, retentionConfig, retentionCutoff } from "./retention";

describe("retentionConfig", () => {
  it("sin variables: 14 días de webhooks, 30 de evaluaciones y un año de chats", () => {
    assert.deepEqual(retentionConfig({}), { processedMessagesDays: 14, engineEvaluationsDays: 30, messagesDays: 365 });
    assert.deepEqual(retentionConfig({}), { ...RETENTION_DEFAULTS });
  });

  it("cada una se cambia por su variable, en días", () => {
    const config = retentionConfig({
      RETENTION_PROCESSED_MESSAGES_DAYS: "7",
      RETENTION_ENGINE_EVALUATIONS_DAYS: " 60 ",
      RETENTION_MESSAGES_DAYS: "180",
    });
    assert.deepEqual(config, { processedMessagesDays: 7, engineEvaluationsDays: 60, messagesDays: 180 });
  });

  it("0 u off la apaga: esa tabla no se borra", () => {
    assert.equal(retentionConfig({ RETENTION_MESSAGES_DAYS: "0" }).messagesDays, null);
    assert.equal(retentionConfig({ RETENTION_MESSAGES_DAYS: "OFF" }).messagesDays, null);
    assert.equal(retentionConfig({ RETENTION_ENGINE_EVALUATIONS_DAYS: "off" }).engineEvaluationsDays, null);
  });

  it("un valor que no es un número de días entero deja el de por defecto", () => {
    for (const raw of ["", "  ", "-5", "1.5", "treinta", "30d"]) {
      assert.equal(retentionConfig({ RETENTION_MESSAGES_DAYS: raw }).messagesDays, 365, raw);
    }
  });

  it("un valor demasiado chico se sube al mínimo: un error al escribirla no borra casi todo el historial", () => {
    assert.equal(retentionConfig({ RETENTION_MESSAGES_DAYS: "3" }).messagesDays, 30);
    assert.equal(retentionConfig({ RETENTION_PROCESSED_MESSAGES_DAYS: "1" }).processedMessagesDays, 2);
    assert.equal(retentionConfig({ RETENTION_ENGINE_EVALUATIONS_DAYS: "1" }).engineEvaluationsDays, 2);
  });
});

describe("retentionCutoff", () => {
  it("resta los días exactos", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    assert.equal(retentionCutoff(14, now).toISOString(), "2026-11-05T12:00:00.000Z");
  });
});
