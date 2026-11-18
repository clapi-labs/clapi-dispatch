import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findPhones, formatPhone, phoneDigits, samePhone } from "./format";

// Prueba de humo del portal: `npm test` descubre y corre pruebas de
// apps/portal/src, y lint, tsc y next build conviven con los *.test.ts.
describe("teléfonos del portal", () => {
  it("phoneDigits deja solo dígitos y le pone el 57 a un celular de diez", () => {
    assert.equal(phoneDigits("300 123 4567"), "573001234567");
    assert.equal(phoneDigits("+57 300 123 4567"), "573001234567");
  });

  it("samePhone compara los últimos diez dígitos, con o sin el 57", () => {
    assert.ok(samePhone("3001234567", "+57 300 123 4567"));
    assert.ok(!samePhone("3001234567", "3001234568"));
  });

  it("formatPhone separa un celular colombiano y deja lo demás como está", () => {
    assert.equal(formatPhone("3001234567"), "+57 300 123 4567");
    assert.equal(formatPhone("123"), "123");
  });

  it("findPhones saca los teléfonos de un texto libre, sin repetir", () => {
    assert.deepEqual(findPhones("Numero cliente: 300 123 4567, o al 3001234567"), ["573001234567"]);
    assert.deepEqual(findPhones("sin teléfono"), []);
  });
});
