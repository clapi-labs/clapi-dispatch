import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errandReason } from "./errand";
import { courierRemovedText, isRemovedCourierReason, removedCourierHoldText, removedCourierReason } from "./fleet-removal";

describe("domiciliario quitado de la flota", () => {
  it("el aviso al quitarlo le dice que no le llegan servicios y cómo pedir volver, por su primer nombre", () => {
    const text = courierRemovedText("  Lauri Gómez ");
    assert.match(text, /^Lauri, la central te quitó de la flota/);
    assert.match(text, /escríbeme Hola/);
  });

  it("si escribe estando fuera, se le dice que la central ya sabe que quiere volver", () => {
    assert.match(removedCourierHoldText("Pedro Pérez"), /^Hola Pedro 👋 Ya no estás en la flota/);
    assert.match(removedCourierHoldText("Pedro Pérez"), /Le avisé a la central/);
  });

  it("el motivo de su chat lleva su nombre y se reconoce por su prefijo", () => {
    const reason = removedCourierReason("Lauri Gómez");
    assert.match(reason, /Lauri Gómez pide volver/);
    assert.equal(isRemovedCourierReason(reason), true);
    assert.equal(isRemovedCourierReason(errandReason("me compran un queso")), false);
    assert.equal(isRemovedCourierReason(null), false);
  });
});
