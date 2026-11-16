import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCourierText } from "./courier-text";
import { deliveryButtons, parseCourierButton, pickupButtons } from "./courier-buttons";

/**
 * Los botones del domiciliario (docs/FLUJO-DOMICILIARIO.md): tres para recoger
 * (lo normal, o recoger y declarar un pendiente de regreso) y tres para
 * entregar, sin «vuelvo».
 */

/** WhatsApp: máximo 3 botones de respuesta, con títulos de hasta 20 caracteres. */
function fitsWhatsApp(buttons: { id: string; title: string }[]) {
  assert.ok(buttons.length <= 3, `${buttons.length} botones`);
  for (const b of buttons) assert.ok([...b.title].length <= 20, `«${b.title}» tiene ${[...b.title].length} caracteres`);
}

describe("los botones caben en WhatsApp", () => {
  it("al recoger: «Recogí», «Llevo datáfono», «Quedé debiendo»", () => {
    const buttons = pickupButtons(12);
    fitsWhatsApp(buttons);
    assert.deepEqual(
      buttons.map((b) => parseCourierButton(b.id)),
      [
        { kind: "picked", tripId: 12, debt: null },
        { kind: "picked", tripId: 12, debt: "datafono" },
        { kind: "picked", tripId: 12, debt: "plata" },
      ],
    );
  });

  it("al entregar: «Entregado», «En portería», «Cliente no contesta»; el pedido termina ahí", () => {
    const buttons = deliveryButtons(12);
    fitsWhatsApp(buttons);
    assert.deepEqual(
      buttons.map((b) => parseCourierButton(b.id)),
      [
        { kind: "delivered", tripId: 12, place: "customer" },
        { kind: "delivered", tripId: 12, place: "gate" },
        { kind: "no_answer", tripId: 12 },
      ],
    );
  });

  it("esperando a un cliente que no contesta, sin esa opción", () => {
    assert.equal(deliveryButtons(12, { waiting: true }).length, 2);
  });

  it("cerrar un pendiente", () => {
    assert.deepEqual(parseCourierButton("debtok:5"), { kind: "debt_done", debtId: 5 });
  });

  it("los botones ya enviados siguen sirviendo: el «vuelvo» de la lista vieja solo marca la entrega", () => {
    assert.deepEqual(parseCourierButton("done:customer:return:9"), { kind: "delivered", tripId: 9, place: "customer" });
    assert.deepEqual(parseCourierButton("done:gate:finish:9"), { kind: "delivered", tripId: 9, place: "gate" });
    assert.deepEqual(parseCourierButton("back:9"), { kind: "back", tripId: 9 });
    assert.equal(parseCourierButton("pickdebt:otra:9"), null);
  });
});

describe("lo que escribe al entregar", () => {
  it("«entregué», «lo dejé en portería»: la entrega; un «y vuelvo» ya no cambia nada", () => {
    assert.deepEqual(parseCourierText("ya entregué"), { kind: "delivered", place: "customer" });
    assert.deepEqual(parseCourierText("entregado y vuelvo"), { kind: "delivered", place: "customer" });
    assert.deepEqual(parseCourierText("lo dejé en portería"), { kind: "delivered", place: "gate" });
  });

  it("«ya volví» ya no es un paso del servicio", () => {
    assert.equal(parseCourierText("ya volví"), null);
  });
});
