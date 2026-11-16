import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fixPaymentMethod, mentionsCardOnDelivery } from "./extraction";
import { isTripOpen, stopsForPhase, tripPhase } from "./phase";
import {
  datafonoLateAt,
  datafonoOutSince,
  debtCloseText,
  debtGroupKey,
  groupDebts,
  joinCodes,
  matchRestaurant,
  parseDebtText,
  type DebtRow,
} from "./return-debts";

/**
 * Pendientes de regreso (docs/FLUJO-DOMICILIARIO.md, «Pendientes de regreso»):
 * lo que escribe el domiciliario, cómo se agrupan y cierran, y cuándo un
 * datáfono lleva demasiado afuera.
 */

describe("parseDebtText: declarar por texto", () => {
  it("«recogí, llevo datáfono» declara el datáfono y cuenta como recogido", () => {
    assert.deepEqual(parseDebtText("recogí, llevo datáfono"), { kind: "declare", reason: "datafono", picked: true, restaurant: null });
    assert.deepEqual(parseDebtText("Ya recogi y llevo el datafono"), { kind: "declare", reason: "datafono", picked: true, restaurant: null });
  });

  it("«llevo el datáfono de Donde Lucho» trae el restaurante", () => {
    assert.deepEqual(parseDebtText("llevo el datáfono de Donde Lucho 👍"), { kind: "declare", reason: "datafono", picked: false, restaurant: "Donde Lucho" });
  });

  it("«quedé debiendo en X», «le debo a X», «debo plata»: plata", () => {
    assert.deepEqual(parseDebtText("quedé debiendo en La Brasa Roja"), { kind: "declare", reason: "plata", picked: false, restaurant: "La Brasa Roja" });
    assert.deepEqual(parseDebtText("le debo a Sushi Cali"), { kind: "declare", reason: "plata", picked: false, restaurant: "Sushi Cali" });
    assert.deepEqual(parseDebtText("recogí, debo plata"), { kind: "declare", reason: "plata", picked: true, restaurant: null });
    assert.equal(parseDebtText("no pude pagar la comida")?.kind, "declare");
  });

  it("cerrar: «ya devolví el datáfono», «ya le pagué a X»", () => {
    assert.deepEqual(parseDebtText("ya devolví el datáfono"), { kind: "close", reason: "datafono", restaurant: null });
    assert.deepEqual(parseDebtText("Devolví el datafono en Donde Lucho"), { kind: "close", reason: "datafono", restaurant: "Donde Lucho" });
    assert.deepEqual(parseDebtText("ya le pagué a Donde Lucho"), { kind: "close", reason: "plata", restaurant: "Donde Lucho" });
    assert.deepEqual(parseDebtText("ya pagué"), { kind: "close", reason: "plata", restaurant: null });
  });

  it("lo negado o largo no cuenta: sigue a la clasificación de siempre", () => {
    assert.equal(parseDebtText("no llevo datáfono"), null);
    assert.equal(parseDebtText("no quedé debiendo nada"), null);
    assert.equal(parseDebtText("ya recogí"), null);
    assert.equal(parseDebtText("el cliente no contesta"), null);
    assert.equal(parseDebtText("tuve un accidente, se me cayó el datáfono y el pedido quedó regado en la calle, necesito ayuda urgente por favor"), null);
  });
});

describe("matchRestaurant", () => {
  const places = [{ name: "Donde Lucho" }, { name: "La Brasa Roja" }, { name: "Sushi Cali" }];

  it("sin tildes ni mayúsculas, y por una parte del nombre", () => {
    assert.equal(matchRestaurant("donde lucho", places)?.name, "Donde Lucho");
    assert.equal(matchRestaurant("Lucho", places)?.name, "Donde Lucho");
    assert.equal(matchRestaurant("la brasa", places)?.name, "La Brasa Roja");
  });

  it("si no coincide ninguno, o coinciden varios, no adivina", () => {
    assert.equal(matchRestaurant("Pizzería Napoli", places), null);
    assert.equal(matchRestaurant("a", places), null);
    assert.equal(matchRestaurant("Cali", [{ name: "Sushi Cali" }, { name: "Cali Burger" }]), null);
  });
});

const t = (min: number) => new Date(Date.UTC(2026, 10, 14, 15, min));
const debt = (over: Partial<DebtRow>): DebtRow => ({
  id: 1,
  courierId: 10,
  restaurantId: 3,
  restaurantName: "Donde Lucho",
  reason: "plata",
  tripId: 100,
  tripCode: "A-01",
  createdAt: t(0),
  deliveredAt: null,
  ...over,
});

describe("groupDebts: los del mismo domiciliario, restaurante y motivo van juntos", () => {
  it("dos de plata del mismo restaurante forman un grupo con sus pedidos", () => {
    const groups = groupDebts([debt({ id: 2, tripCode: "A-02", createdAt: t(10) }), debt({ id: 1, tripCode: "A-01", createdAt: t(0) })]);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].debts.map((d) => d.tripCode),
      ["A-01", "A-02"],
    );
    assert.equal(groups[0].since.getTime(), t(0).getTime());
  });

  it("otro motivo, otro restaurante u otro domiciliario son otro grupo", () => {
    const groups = groupDebts([
      debt({ id: 1 }),
      debt({ id: 2, reason: "datafono" }),
      debt({ id: 3, restaurantId: 4, restaurantName: "Sushi Cali" }),
      debt({ id: 4, courierId: 11 }),
    ]);
    assert.equal(groups.length, 4);
  });

  it("un restaurante sin registrar se reconoce por su nombre, sin tildes ni mayúsculas", () => {
    const a = debtGroupKey(debt({ restaurantId: null, restaurantName: "Pizzería Napoli" }));
    const b = debtGroupKey(debt({ restaurantId: null, restaurantName: "pizzeria napoli" }));
    assert.equal(a, b);
  });

  it("el grupo más viejo primero", () => {
    const groups = groupDebts([debt({ id: 1, courierId: 11, createdAt: t(20) }), debt({ id: 2, courierId: 12, createdAt: t(5) })]);
    assert.deepEqual(
      groups.map((g) => g.courierId),
      [12, 11],
    );
  });
});

describe("el aviso del datáfono", () => {
  it("cuenta desde que se entregó el pedido; antes lo está usando", () => {
    assert.equal(datafonoOutSince(debt({ reason: "datafono", deliveredAt: null })), null);
    assert.equal(datafonoOutSince(debt({ reason: "datafono", deliveredAt: t(12) }))?.getTime(), t(12).getTime());
  });

  it("uno registrado a mano sin pedido cuenta desde que se registró", () => {
    assert.equal(datafonoOutSince(debt({ reason: "datafono", tripId: null, tripCode: null, createdAt: t(3) }))?.getTime(), t(3).getTime());
  });

  it("sale a los 30 minutos por defecto, o a los que se pongan en el portal", () => {
    const d = debt({ reason: "datafono", deliveredAt: t(10) });
    assert.equal(datafonoLateAt(d, 30)?.getTime(), t(40).getTime());
    assert.equal(datafonoLateAt(d, 5)?.getTime(), t(15).getTime());
  });

  it("la plata no tiene aviso de demora", () => {
    assert.equal(datafonoLateAt(debt({ reason: "plata", deliveredAt: t(10) }), 30), null);
  });
});

describe("los mensajes para cerrarlo", () => {
  it("al entregar: devolver el datáfono, o la plata anotada", () => {
    assert.equal(debtCloseText("datafono", "Donde Lucho", ["A-07"]), "💳 Devuelve el datáfono en Donde Lucho (A-07). Cuando lo hagas, toca «Ya lo devolví».");
    assert.equal(debtCloseText("plata", "Donde Lucho", ["A-07", "A-08"]), "💵 Quedó anotado que le debes a Donde Lucho (A-07 y A-08). Cuando le pagues, toca «Ya pagué».");
  });

  it("«Mandar ya» desde el portal", () => {
    assert.equal(debtCloseText("datafono", "Donde Lucho", [null], { nudge: true }), "📢 Pasa por Donde Lucho a devolver el datáfono. Cuando lo hagas, toca «Ya lo devolví».");
  });

  it("joinCodes", () => {
    assert.equal(joinCodes(["A-01", "A-02", "A-03"]), "A-01, A-02 y A-03");
    assert.equal(joinCodes([null]), "");
  });
});

describe("al entregar termina el servicio: ya no existe «Volviendo»", () => {
  it("un viaje entregado está entregado (o en portería), aunque tenga la marca vieja de regreso", () => {
    const old = { status: "delivered", deliveredAt: t(10), returnStartedAt: t(10), finishedAt: null } as Parameters<typeof tripPhase>[0];
    assert.equal(tripPhase(old), "delivered");
    assert.equal(tripPhase({ status: "delivered", deliveryPlace: "gate" }), "gate");
    assert.equal(isTripOpen({ status: "delivered" }), false);
  });

  it("el algoritmo no supone el regreso: recoger y entregar, nada más", () => {
    assert.deepEqual(stopsForPhase("going"), ["R", "C"]);
    assert.deepEqual(stopsForPhase("carrying"), ["C"]);
    assert.deepEqual(stopsForPhase("delivered"), []);
  });
});

describe("«tarjeta» y «datáfono» se leen como datáfono, no como ya pagado", () => {
  it("lo que dice el restaurante", () => {
    for (const text of ["lleve datáfono", "paga con tarjeta", "el cliente paga con datafono", "Tarjeta", "pago crédito o débito"]) {
      assert.equal(mentionsCardOnDelivery(text), true, text);
    }
    for (const text of ["ya está pagado", "pagó con tarjeta por la página", "pagado con tarjeta", "efectivo, lleva cambio de 50"]) {
      assert.equal(mentionsCardOnDelivery(text), false, text);
    }
  });

  it("corrige lo que el modelo leyó como transferencia", () => {
    assert.deepEqual(fixPaymentMethod([{ metodoPago: "transferencia" as const }], "domi para Ana, paga con tarjeta"), [{ metodoPago: "datafono" }]);
  });

  it("con una sola entrega sin método, también; lo demás no se toca", () => {
    assert.deepEqual(fixPaymentMethod([{ metodoPago: null }], "lleve datáfono"), [{ metodoPago: "datafono" }]);
    assert.deepEqual(fixPaymentMethod([{ metodoPago: "efectivo" as const }], "lleve datáfono"), [{ metodoPago: "efectivo" }]);
    assert.deepEqual(fixPaymentMethod([{ metodoPago: null }, { metodoPago: null }], "lleve datáfono"), [{ metodoPago: null }, { metodoPago: null }]);
    assert.deepEqual(fixPaymentMethod([{ metodoPago: "transferencia" as const }], "ya está pagado por Nequi"), [{ metodoPago: "transferencia" }]);
  });
});
