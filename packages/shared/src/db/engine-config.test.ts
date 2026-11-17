import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_ENGINE_CONFIG, normalizeEngineConfig } from "./engine-config";

describe("normalizeEngineConfig", () => {
  it("sin fila guardada asigna el engine, no la cola", () => {
    assert.deepEqual(normalizeEngineConfig(undefined), DEFAULT_ENGINE_CONFIG);
    assert.equal(DEFAULT_ENGINE_CONFIG.mode, "auto");
  });

  it("las filas de la época de la cola (queue, shadow) se leen como auto", () => {
    for (const mode of ["queue", "shadow"]) {
      assert.equal(normalizeEngineConfig({ mode, radioKm: 6, multipedido: false }).mode, "auto");
    }
  });

  it("conserva manual y los demás ajustes de una fila vieja", () => {
    assert.deepEqual(normalizeEngineConfig({ mode: "shadow", radioKm: 6, multipedido: false }), { mode: "auto", radioKm: 6, multipedido: false });
    assert.equal(normalizeEngineConfig({ mode: "manual" }).mode, "manual");
  });

  it("ignora valores que no se entienden", () => {
    assert.deepEqual(normalizeEngineConfig({ mode: 3, radioKm: -1, multipedido: "sí" }), DEFAULT_ENGINE_CONFIG);
    assert.deepEqual(normalizeEngineConfig(null), DEFAULT_ENGINE_CONFIG);
  });
});
