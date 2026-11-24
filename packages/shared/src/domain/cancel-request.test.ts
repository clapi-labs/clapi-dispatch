import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelReason, cancelReceivedText, looksLikeCancelRequest } from "./cancel-request";

describe("looksLikeCancelRequest", () => {
  it("reconoce que pide cancelar un pedido ya creado", () => {
    for (const text of [
      "ahn no se demora mucho me lo cancelas ?",
      "cancelame el a57",
      "Cancélame el A-57 porfa",
      "cancela el pedido",
      "cancelen ese domi, ya no va",
      "por favor cancelarlo",
      "ya no lo mandes, cancélalo",
      "quiero cancelar el domicilio",
      "anula el servicio",
      "el cliente canceló",
      "el cliente ya lo canceló, no lo manden",
      "nos la cancelan porfa",
    ]) {
      assert.equal(looksLikeCancelRequest(text), true, text);
    }
  });

  it("«cancelar» como pagar no es cancelar el pedido", () => {
    for (const text of [
      "el cliente cancela en efectivo",
      "cancela con billete de 50",
      "el cliente cancela 35 mil",
      "el cliente ya canceló por Nequi",
      "le cancela al domi cuando llegue",
      "cancela el domicilio en efectivo",
      "cancela contra entrega",
      "Calle 10 # 5-20, Marta 3001234567, cancela con tarjeta, lleve datáfono",
    ]) {
      assert.equal(looksLikeCancelRequest(text), false, text);
    }
  });

  it("quitar una entrega del pedido que se está armando, o un mensaje normal, no", () => {
    for (const text of ["quita la 2", "el de Pance ya no va", "cancela la 2", "Necesito un domi", "¿ya llegó el A-57?", "", null]) {
      assert.equal(looksLikeCancelRequest(text), false, String(text));
    }
  });
});

describe("textos de la cancelación", () => {
  it("con un pedido nombra el código; con varios abiertos, la central decide cuál", () => {
    assert.equal(cancelReason(["A-57"]), "Pidió cancelar el pedido A-57.");
    assert.equal(cancelReason(["A-56", "A-57", "A-58"]), "Pidió cancelar un pedido sin decir cuál: tiene abiertos A-56, A-57 y A-58.");
    assert.match(cancelReceivedText(["A-57"]), /quieres cancelar el A-57/);
    assert.match(cancelReceivedText(["A-56", "A-57"]), /quieres cancelar tu pedido/);
  });
});
