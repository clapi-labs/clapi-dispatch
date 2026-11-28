import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliveryLabel, foldTicket, onlyOneOf, pickAlternative, type DeliveryDraft } from "./extraction";
import { notServedPlaceText, placeOnly, servedPlaceText } from "./places";

describe("placeOnly", () => {
  it("un municipio solo, como lo escriben", () => {
    assert.deepEqual(placeOnly("Jamundí"), { name: "Jamundí", served: true });
    assert.deepEqual(placeOnly("jamundi"), { name: "Jamundí", served: true });
    assert.deepEqual(placeOnly("para Jamundí, Valle"), { name: "Jamundí", served: true });
    assert.deepEqual(placeOnly("Cali"), { name: "Cali", served: true });
    assert.deepEqual(placeOnly("Palmira"), { name: "Palmira", served: false });
    assert.deepEqual(placeOnly("hasta yumbo"), { name: "Yumbo", served: false });
    assert.deepEqual(placeOnly("Medellín"), { name: "Medellín", served: false });
  });

  it("una dirección o un lugar de la ciudad no es un municipio solo", () => {
    for (const address of ["Calle 10 # 5-20, Jamundí", "Alfaguara, Jamundí", "Pance", "Unidad Reserva Campestre", "Comuna 16", null, ""]) {
      assert.equal(placeOnly(address), null, String(address));
    }
  });

  it("los textos", () => {
    assert.match(servedPlaceText("Jamundí"), /^¡Sí! Llegamos a Jamundí 🙌 El precio depende de la dirección/);
    assert.equal(notServedPlaceText("Palmira"), "Qué pena 🙏 A Palmira no llegamos: manejamos Cali y Jamundí.");
  });
});

describe("deliveryLabel", () => {
  it("el barrio, salvo que sea una comuna: ahí, el comienzo de la dirección", () => {
    assert.equal(deliveryLabel({ barrio: "Ciudad Jardín", direccionEntrega: "Calle 10 # 5-20" }), "Ciudad Jardín");
    assert.equal(deliveryLabel({ barrio: "Comuna 16", direccionEntrega: "Calle 40 # 80-10, Los Cerezos" }), "Calle 40 # 80-10");
    assert.equal(deliveryLabel({ barrio: null, direccionEntrega: null }), "la entrega");
  });
});

describe("onlyOneOf", () => {
  const entregas = [
    { barrio: null, direccionEntrega: "Jamundí" },
    { barrio: "Comuna 16", direccionEntrega: "Calle 40 # 80-10, Los Cerezos" },
  ];

  it("«solo necesito el de X»: quita las demás", () => {
    assert.deepEqual(onlyOneOf("nono solo necesito el de la comuna 16, vale.. nombre del cliente Ramiro", entregas), [1]);
    assert.deepEqual(onlyOneOf("solo el de Jamundí", entregas), [2]);
    assert.deepEqual(onlyOneOf("solo va el de la calle 40", entregas), [1]);
    assert.deepEqual(onlyOneOf("solo la segunda", entregas), [1]);
    assert.deepEqual(onlyOneOf("solo el primero porfa", entregas), [2]);
  });

  it("sin decir cuál, con una sola entrega o sin «solo», no quita nada", () => {
    assert.deepEqual(onlyOneOf("solo eso, gracias", entregas), []);
    assert.deepEqual(onlyOneOf("el de la comuna 16 es para Ramiro", entregas), []);
    assert.deepEqual(onlyOneOf("solo el de la comuna 16", [entregas[1]]), []);
    assert.deepEqual(onlyOneOf(null, entregas), []);
  });
});

const piece = (over: Partial<DeliveryDraft>): DeliveryDraft => ({
  direccionEntrega: null,
  telefonoCliente: null,
  nombreCliente: null,
  valorACobrar: null,
  metodoPago: null,
  listoEnMinutos: null,
  notas: null,
  detalleDireccion: null,
  esConjunto: null,
  ...over,
});

describe("foldTicket", () => {
  it("los trozos sin cliente vuelven a la entrega del cliente: el conjunto y la puerta se suman, otra calle va de alterna", () => {
    const [one, ...rest] = foldTicket([
      piece({ direccionEntrega: "Kra 10 # 5-20, Los Robles", telefonoCliente: "3001234567", direccionAlterna: "Cra 12 # 8-30, Torre 2 Apt 707" }),
      piece({ direccionEntrega: "Unidad Las Palmas", detalleDireccion: "Torre 4 apt 106", esConjunto: true }),
    ]);
    assert.equal(rest.length, 0);
    assert.equal(one.direccionEntrega, "Kra 10 # 5-20, Los Robles, Unidad Las Palmas");
    assert.equal(one.detalleDireccion, "Torre 4 apt 106");
    assert.equal(one.direccionAlterna, "Cra 12 # 8-30, Torre 2 Apt 707");
    assert.equal(one.esConjunto, true);

    const [two] = foldTicket([piece({ direccionEntrega: "Kra 10 # 5-20", nombreCliente: "Ana" }), piece({ direccionEntrega: "Cra 12 # 8-30", detalleDireccion: "Torre 2 Apt 707" })]);
    assert.equal(two.direccionAlterna, "Cra 12 # 8-30, Torre 2 Apt 707");
  });

  it("dos clientes son dos entregas, y una sola entrega no cambia", () => {
    const two = [piece({ direccionEntrega: "Kra 10 # 5-20", nombreCliente: "Ana" }), piece({ direccionEntrega: "Cra 12 # 8-30", nombreCliente: "Luis" })];
    assert.equal(foldTicket(two).length, 2);
    const single = [piece({ direccionEntrega: "Kra 10 # 5-20" })];
    assert.equal(foldTicket(single), single);
  });
});

describe("pickAlternative", () => {
  const d = { direccionEntrega: "Kra 10 # 5-20, Los Robles", detalleDireccion: "Torre 4 apt 106", direccionAlterna: "Cra 12 bis # 8-30, Unidad Las Palmas, Torre 2 Apt 707" };

  it("por orden o por lo que solo tiene una", () => {
    assert.equal(pickAlternative("la segunda", d), 2);
    assert.equal(pickAlternative("2", d), 2);
    assert.equal(pickAlternative("la otra porfa", d), 2);
    assert.equal(pickAlternative("la primera", d), 1);
    assert.equal(pickAlternative("la de las palmas", d), 2);
    assert.equal(pickAlternative("la que dice palmas", d), 2);
    assert.equal(pickAlternative("Los Robles", d), 1);
  });

  it("si no queda claro, null", () => {
    assert.equal(pickAlternative("torre 4", d), null);
    assert.equal(pickAlternative("Lista en 10, el cliente paga en efectivo con billete de 50 mil y hay que llevar cambio", d), null);
    assert.equal(pickAlternative("la segunda", { ...d, direccionAlterna: null }), null);
  });
});
