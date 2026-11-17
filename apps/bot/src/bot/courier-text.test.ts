import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDisconnect } from "./courier-text";

describe("isDisconnect: terminar el turno", () => {
  it("reconoce «desactivado» sin importar mayúsculas, tildes ni signos", () => {
    for (const sample of [
      "desactivado",
      "Desactivado",
      "DESACTIVADO",
      "desactivada",
      "Desactivado.",
      "DESACTIVADO 👍",
      "¡Desactívado!",
      "desactivádo 🙏",
      "desactivadó 👋🏻",
      "désactivado...",
      "«desactivado»",
      "  desactivado  ",
    ]) {
      assert.equal(isDisconnect(sample), true, `debió reconocer: ${JSON.stringify(sample)}`);
    }
  });

  it("acepta variantes directas como «desactivar» o «me desactivo»", () => {
    for (const sample of ["desactivar", "desactivarme", "me desactivo", "Me desactivo.", "ME DESACTIVO 👍"]) {
      assert.equal(isDisconnect(sample), true, `debió reconocer: ${JSON.stringify(sample)}`);
    }
  });

  it("no se confunde con frases normales que contengan la palabra", () => {
    for (const sample of [
      "el pedido está desactivado",
      "no me he desactivado",
      "por qué salgo desactivado?",
      "me desactivo en 10 minutos",
      "desactivado por hoy",
      "hola",
      "",
      "👍",
    ]) {
      assert.equal(isDisconnect(sample), false, `no debió reconocer: ${JSON.stringify(sample)}`);
    }
  });
});
