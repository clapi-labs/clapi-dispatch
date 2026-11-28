import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { looksLikeDelayComplaint } from "./status";

describe("looksLikeDelayComplaint", () => {
  it("reclama que el domiciliario no llega o se demoró", () => {
    for (const text of [
      "el domiciliario aun no llega",
      "el domiciliario no viene por el pedido aun",
      "la moto no ha llegado",
      "ya se demoró mucho",
      "hace rato pedí el domi",
      "qué pasó con el domi?",
      "lleva 20 minutos y no llega",
      "todavía no llega el motorizado",
    ]) {
      assert.equal(looksLikeDelayComplaint(text), true, text);
    }
  });

  it("una pregunta de estado o el restaurante avisando de su comida no es un reclamo", () => {
    for (const text of ["ya viene en camino?", "dime el estado del A61", "ya se entregó el A-61?", "se demora 5 más", "el pedido se demora 10 min", "ya está listo", "", null]) {
      assert.equal(looksLikeDelayComplaint(text), false, String(text));
    }
  });
});
