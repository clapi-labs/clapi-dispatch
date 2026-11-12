import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { healthProblems, WORKER_STALE_MS, type HealthInput } from "./verdict";

const now = new Date("2026-11-12T15:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const healthy: HealthInput = { now, missingEnv: [], database: true, lastTickAt: ago(5_000), engine: "off" };

describe("healthProblems", () => {
  it("sano: base, worker reciente y engine sin revisar o respondiendo", () => {
    assert.deepEqual(healthProblems(healthy), []);
    assert.deepEqual(healthProblems({ ...healthy, engine: "ok" }), []);
  });

  it("la base de datos no contesta", () => {
    assert.deepEqual(healthProblems({ ...healthy, database: false, lastTickAt: null }), ["la base de datos no contesta"]);
  });

  it("sin base no se reporta el worker: no se puede saber", () => {
    assert.equal(healthProblems({ ...healthy, database: false, lastTickAt: null, engine: "down" }).length, 1);
  });

  it("el worker se detuvo: más de 2 minutos sin vueltas", () => {
    assert.deepEqual(healthProblems({ ...healthy, lastTickAt: ago(WORKER_STALE_MS - 1_000) }), []);
    assert.match(healthProblems({ ...healthy, lastTickAt: ago(WORKER_STALE_MS + 1_000) })[0], /worker lleva 121 s/);
  });

  it("el worker nunca corrió", () => {
    assert.deepEqual(healthProblems({ ...healthy, lastTickAt: null }), ["el worker nunca ha completado una vuelta"]);
  });

  it("el engine caído en modo auto", () => {
    assert.deepEqual(healthProblems({ ...healthy, engine: "down" }), ["el engine no responde y está en modo auto"]);
  });

  it("falta configuración", () => {
    assert.deepEqual(healthProblems({ ...healthy, missingEnv: ["OPENAI_API_KEY"] }), ["faltan variables: OPENAI_API_KEY"]);
  });

  it("varios problemas a la vez se reportan todos", () => {
    assert.equal(healthProblems({ ...healthy, missingEnv: ["X"], lastTickAt: null, engine: "down" }).length, 3);
  });
});
