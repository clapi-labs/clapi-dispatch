import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chargesOnCancel, courierCancelledText, restaurantCancelledText } from "./trip-cancel";

const plain = (s: string) => s.replace(/\s+/g, " ");

describe("chargesOnCancel", () => {
  it("se cobra si la moto ya salió del restaurante con el pedido; antes, no", () => {
    assert.equal(chargesOnCancel({ kind: "delivery", pickedUpAt: new Date() }), true);
    assert.equal(chargesOnCancel({ kind: "delivery", pickedUpAt: "2026-11-26T20:00:00Z" }), true);
    assert.equal(chargesOnCancel({ kind: "delivery", pickedUpAt: null }), false);
    assert.equal(chargesOnCancel({}), false);
  });

  it("un encargo no marca recogida: no se cobra por regla", () => {
    assert.equal(chargesOnCancel({ kind: "errand", pickedUpAt: new Date() }), false);
  });
});

describe("textos de la cancelación", () => {
  it("a la moto, según si ya tenía el pedido", () => {
    assert.equal(courierCancelledText({ code: "A-57", errand: false, pickedUp: false }), "❌ La central canceló el A-57: ya no lo llevas, no vayas a recogerlo 🙏");
    assert.match(courierCancelledText({ code: "A-57", errand: false, pickedUp: true }), /Si tienes el pedido contigo/);
    assert.equal(courierCancelledText({ code: "A-15", errand: true, pickedUp: false }), "❌ La central canceló el encargo A-15: ya no lo hagas 🙏");
  });

  it("al restaurante, con lo que se cobra si se cobra", () => {
    assert.equal(restaurantCancelledText({ code: "A-57", errand: false, charged: null }), "❌ Tu pedido A-57 quedó cancelado.");
    assert.equal(restaurantCancelledText({ code: "A-15", errand: true, charged: null }), "❌ Tu encargo A-15 quedó cancelado.");
    assert.equal(
      plain(restaurantCancelledText({ code: "A-57", errand: false, charged: 8_000 })),
      "❌ Tu pedido A-57 quedó cancelado. Como el domiciliario ya había salido, se cobra el domicilio: $ 8.000.",
    );
  });
});
