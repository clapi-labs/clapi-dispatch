import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  emptyDelivery,
  looksLikeMultiUnit,
  mergeTripFields,
  missingFields,
  priceQuestionPlace,
  rescuePriceQuestion,
  separateDoor,
  splitDoor,
  DEFAULT_REQUIRED_FIELDS,
  type DeliveryDraft,
  type Interpretation,
  type OrderDraft,
} from "./extraction";

/**
 * La puerta (torre, apto, casa…) aparte de la dirección que va al mapa (#86):
 * casos reales de Cali, como los escriben los restaurantes por WhatsApp.
 */

type Row = [input: string, direccion: string, detalle: string];

describe("splitDoor: la puerta sale de la dirección y se queda completa", () => {
  const rows: Row[] = [
    // El caso real de staging.
    ["Unidad Reserva campestre, Torre 4 Apto 803", "Unidad Reserva campestre", "Torre 4 Apto 803"],
    ["Unidad Reserva campestre, Torre 4 apto 803", "Unidad Reserva campestre", "Torre 4 apto 803"],
    ["Unidad de Reserva Campestre Torre 2 Apto 1101", "Unidad de Reserva Campestre", "Torre 2 Apto 1101"],
    ["Conjunto Reserva Campestre torre 1 apto 305", "Conjunto Reserva Campestre", "Torre 1 apto 305"],
    ["reserva campestre torre 4 apto 803 pance", "reserva campestre pance", "Torre 4 apto 803"],
    // La puerta dicha primero.
    ["Torre 4 Apto 803, Unidad Reserva campestre", "Unidad Reserva campestre", "Torre 4 Apto 803"],
    ["Bloque C apto 202 Conjunto Los Pinos", "Conjunto Los Pinos", "Bloque C apto 202"],
    // Con vía y placa.
    ["Cl 45 #97a-15 torre 2 apto 502", "Cl 45 #97a-15", "Torre 2 apto 502"],
    ["Cra 97 # 58-31 Ciudad Melendez casa 6", "Cra 97 # 58-31 Ciudad Melendez", "Casa 6"],
    ["Cra 98 #42-105 fusion plaza local 5", "Cra 98 #42-105 fusion plaza", "Local 5"],
    ["Calle 48 # 106-83 Bochalema, casa 2", "Calle 48 # 106-83 Bochalema", "Casa 2"],
    ["Cra 83 # 38-2, interior 3", "Cra 83 # 38-2", "Interior 3"],
    ["Cl 56 # 85C1-78 piso 2", "Cl 56 # 85C1-78", "Piso 2"],
    ["Carrera 97 # 42-10 Calicanto, oficina 204", "Carrera 97 # 42-10 Calicanto", "Oficina 204"],
    ["Cra. 98 # 42-55, apto 301", "Cra. 98 # 42-55", "Apto 301"],
    ["cra97#45-11 loc 102", "cra97#45-11", "Loc 102"],
    // La puerta en medio: el barrio se queda.
    ["Cra 86 # 38-111 local 11, Altos del Caney", "Cra 86 # 38-111, Altos del Caney", "Local 11"],
    ["Calle 5 # 66-20, Edificio Torre Alta apto 1203, El Refugio", "Calle 5 # 66-20, Edificio Torre Alta, El Refugio", "Apto 1203"],
    ["Conjunto Alfaguara Torre 2 apto 301, Jamundí", "Conjunto Alfaguara, Jamundí", "Torre 2 apto 301"],
    // Formas de escribirla.
    ["Edificio Ceibas Torre A apto 301", "Edificio Ceibas", "Torre A apto 301"],
    ["Conjunto Los Pinos manzana 5 casa 4", "Conjunto Los Pinos", "Manzana 5 casa 4"],
    ["Cra 5 # 4-3 apto803", "Cra 5 # 4-3", "Apto 803"],
    ["Carrera 12 # 4-5 Torre 3 - Apto 1204", "Carrera 12 # 4-5", "Torre 3 Apto 1204"],
    ["Cl 3 # 4-5 Apto N° 502", "Cl 3 # 4-5", "Apto N° 502"],
    ["Cl 3 # 4-5 apartamento 12B", "Cl 3 # 4-5", "Apartamento 12B"],
    ["Cl 3 # 4-5 bl 2 ap 301", "Cl 3 # 4-5", "Bl 2 ap 301"],
  ];

  for (const [input, direccion, detalle] of rows) {
    it(`«${input}»`, () => {
      const split = splitDoor(input);
      assert.equal(split.direccion, direccion);
      assert.equal(split.detalle, detalle);
    });
  }

  it("con torre, bloque o apto es de varias familias; con casa o local, no", () => {
    assert.equal(splitDoor("Unidad Reserva campestre, Torre 4 Apto 803").multiUnit, true);
    assert.equal(splitDoor("Cra 97 # 58-31 casa 6").multiUnit, false);
    assert.equal(splitDoor("Cra 98 #42-105 local 5").multiUnit, false);
  });
});

describe("splitDoor: lo que es un nombre o no es una puerta se queda", () => {
  const same = [
    "Edificio Torre Alta",
    "Casa Blanca, Cra 5 # 4-3",
    "Conjunto Casas del Río, Cra 5 # 4-3",
    "Torres de Comfandi",
    "Calle 5 # 66-20 casa a la esquina",
    "Torre 2 del Conjunto Los Pinos, Cl 5 # 10-20",
    "Local 3, Cra 50 # 10-20",
    "Clínica Valle del Lili",
    "Calle 42 con Carrera 85C",
    "Cra 100 # 5-169 Unicentro",
    "Casa de la Cultura",
    "Hospital Universitario del Valle",
  ];
  for (const input of same) {
    it(`«${input}»`, () => {
      const split = splitDoor(input);
      assert.equal(split.direccion, input);
      assert.equal(split.detalle, null);
    });
  }

  it("si no queda dirección, no separa nada: la puerta sola es una puerta", () => {
    for (const door of ["Torre 4 apto 803", "casa 14", "Apto 803", "Local 3"]) {
      assert.equal(splitDoor(door).detalle, null, door);
      assert.equal(splitDoor(door).direccion, door);
    }
  });

  it("vacío o nulo", () => {
    assert.deepEqual(splitDoor(null), { direccion: "", detalle: null, multiUnit: false });
    assert.deepEqual(splitDoor("   "), { direccion: "", detalle: null, multiUnit: false });
  });

  it("para el mapa (`all`), también la puerta del comienzo", () => {
    assert.equal(splitDoor("Local 3, Cra 50 # 10-20", { all: true }).direccion, "Cra 50 # 10-20");
    assert.equal(splitDoor("Torre 2 del Conjunto Los Pinos, Cl 5 # 10-20", { all: true }).direccion, "Conjunto Los Pinos, Cl 5 # 10-20");
  });
});

describe("separateDoor: lo que el modelo dejó en la dirección pasa a la puerta", () => {
  const fields = (patch: Partial<Interpretation["entregas"][number]>) => ({ ...emptyDelivery(), ...patch });

  it("el caso de staging: «Unidad Reserva campestre, Torre 4 apto 803» deja la torre y el apto completos", () => {
    const out = separateDoor(fields({ direccionEntrega: "Unidad Reserva campestre, Torre 4 apto 803" }));
    assert.equal(out.direccionEntrega, "Unidad Reserva campestre");
    assert.equal(out.detalleDireccion, "Torre 4 apto 803");
    assert.equal(out.esConjunto, true);
  });

  it("si el modelo ya la separó, no cambia nada", () => {
    const ok = fields({ direccionEntrega: "Unidad Reserva campestre", detalleDireccion: "Torre 4 apto 803", esConjunto: true });
    assert.deepEqual(separateDoor(ok), ok);
  });

  it("si el modelo puso solo el apto como puerta y la torre quedó en la dirección, quedan las dos", () => {
    const out = separateDoor(fields({ direccionEntrega: "Unidad Reserva campestre, Torre 4", detalleDireccion: "apto 803" }));
    assert.equal(out.direccionEntrega, "Unidad Reserva campestre");
    assert.equal(out.detalleDireccion, "Torre 4 apto 803");
  });

  it("no repite la puerta que ya estaba completa", () => {
    const out = separateDoor(fields({ direccionEntrega: "Unidad Reserva campestre, Torre 4 apto 803", detalleDireccion: "Torre 4 apto 803" }));
    assert.equal(out.detalleDireccion, "Torre 4 apto 803");
  });

  it("no pone conjunto a una casa ni cambia lo que el modelo dijo", () => {
    const house = separateDoor(fields({ direccionEntrega: "Cra 97 # 58-31 Ciudad Melendez casa 6" }));
    assert.equal(house.esConjunto, null);
    const said = separateDoor(fields({ direccionEntrega: "Cra 5 # 4-3 casa 6", esConjunto: false }));
    assert.equal(said.esConjunto, false);
  });
});

describe("el pedido del caso real, de punta a punta", () => {
  const draft = (): OrderDraft => ({ etapa: "recibiendo", origenRestaurante: "Donde Lucho", entregas: [] });
  const first: Interpretation = {
    origenRestaurante: null,
    entregas: [{ ...emptyDelivery(), direccionEntrega: "Unidad Reserva campestre, Torre 4 apto 803", nombreCliente: "Carlos Gómez", telefonoCliente: "3007654321", listoEnMinutos: 5 }],
  };

  it("«Unidad Reserva campestre, Torre 4 Apto 803 · Carlos Gómez 300 765 4321 · en 5» queda con la puerta aparte y sin pedir nada más", () => {
    const merged = mergeTripFields(draft(), first);
    const [delivery] = merged.entregas;
    assert.equal(delivery.direccionEntrega, "Unidad Reserva campestre");
    assert.equal(delivery.detalleDireccion, "Torre 4 apto 803");
    assert.equal(delivery.esConjunto, true);
    assert.deepEqual(missingFields(delivery, DEFAULT_REQUIRED_FIELDS), []);
  });

  it("una sola entrega aunque los datos lleguen después", () => {
    const addressOnly: Interpretation = { origenRestaurante: null, entregas: [{ ...emptyDelivery(), direccionEntrega: "Unidad Reserva campestre, Torre 4 Apto 803" }] };
    const step1 = mergeTripFields(draft(), addressOnly);
    const step2 = mergeTripFields(step1, { origenRestaurante: null, entregas: [{ ...emptyDelivery(), nombreCliente: "Carlos Gómez", telefonoCliente: "3007654321", listoEnMinutos: 5 }] });
    assert.equal(step2.entregas.length, 1);
    assert.equal(step2.entregas[0].direccionEntrega, "Unidad Reserva campestre");
    assert.equal(step2.entregas[0].detalleDireccion, "Torre 4 Apto 803");
  });

  it("el mismo conjunto, dicho sin torre después, no cambia la dirección ya separada", () => {
    const step1: DeliveryDraft[] = mergeTripFields(draft(), first).entregas;
    const again = mergeTripFields({ ...draft(), entregas: step1 }, { origenRestaurante: null, entregas: [{ ...emptyDelivery(), direccionEntrega: "Unidad Reserva campestre" }] });
    assert.equal(again.entregas.length, 1);
    assert.equal(again.entregas[0].detalleDireccion, "Torre 4 apto 803");
  });
});

describe("«unidad de…» con un nombre propio es un conjunto; una unidad médica o deportiva, no", () => {
  it("unidad de reserva campestre", () => {
    assert.equal(looksLikeMultiUnit("unidad de reserva campestre"), true);
    assert.equal(looksLikeMultiUnit("Unidad Reserva campestre"), true);
    assert.equal(looksLikeMultiUnit("Unidad de Reserva Campestre, Torre 4 apto 803"), false);
  });

  it("unidades que no son un conjunto", () => {
    for (const place of ["Unidad Deportiva Alberto Galindo", "Unidad Médica Imbanaco", "Unidad de cuidados intensivos", "Unidad de urgencias Clínica Valle del Lili", "Unidad de salud mental"]) {
      assert.equal(looksLikeMultiUnit(place), false, place);
    }
  });

  it("sin la torre y el apto, un conjunto por su nombre los pide", () => {
    const delivery = { ...emptyDelivery(), direccionEntrega: "unidad de reserva campestre", nombreCliente: "Ana", telefonoCliente: "3001234567", listoEnMinutos: 5 };
    assert.deepEqual(missingFields(delivery, DEFAULT_REQUIRED_FIELDS), ["detalleDireccion"]);
  });
});

describe("preguntar el precio a un conjunto por su nombre no es confuso", () => {
  it("el mensaje real de staging", () => {
    assert.equal(priceQuestionPlace("hola buenas que cuesta hasta la unidad de reserva campestre ?"), "Unidad de reserva campestre");
  });

  it("otras formas de preguntarlo", () => {
    assert.equal(priceQuestionPlace("¿Cuánto cuesta hasta el conjunto Bosques del Lili?"), "Conjunto Bosques del Lili");
    assert.equal(priceQuestionPlace("cuanto vale un domicilio a la unidad alameda"), "Unidad alameda");
    assert.equal(priceQuestionPlace("precio para el edificio ceibas?"), "Edificio ceibas");
    assert.equal(priceQuestionPlace("Cotízame hasta Conjunto Los Pinos"), "Conjunto Los Pinos");
    assert.equal(priceQuestionPlace("buenas tardes, cuánto sale hasta condominio campestre pance"), "Condominio campestre pance");
  });

  it("no es una pregunta de precio a un conjunto", () => {
    assert.equal(priceQuestionPlace("cuanto cuesta a la cra 98 # 45-30"), null);
    assert.equal(priceQuestionPlace("envíame una moto a la unidad reserva campestre"), null);
    assert.equal(priceQuestionPlace("hasta la unidad"), null);
    assert.equal(priceQuestionPlace("hola"), null);
    assert.equal(priceQuestionPlace(null), null);
  });

  it("si el modelo lo marcó confuso y no leyó la dirección, la entrega es el conjunto", () => {
    const out = rescuePriceQuestion("hola buenas que cuesta hasta la unidad de reserva campestre ?", [], true);
    assert.equal(out.confused, false);
    assert.equal(out.rescued, true);
    assert.equal(out.entregas.length, 1);
    assert.equal(out.entregas[0].direccionEntrega, "Unidad de reserva campestre");
    assert.equal(out.entregas[0].esConjunto, true);
  });

  it("si leyó una entrega sin dirección, se la pone", () => {
    const out = rescuePriceQuestion("cuanto vale hasta la unidad reserva campestre", [{ ...emptyDelivery(), nombreCliente: "Ana" }], false);
    assert.equal(out.entregas.length, 1);
    assert.equal(out.entregas[0].direccionEntrega, "Unidad reserva campestre");
    assert.equal(out.entregas[0].nombreCliente, "Ana");
  });

  it("si el modelo ya leyó la dirección, la respeta y deja de ser confuso", () => {
    const read = [{ ...emptyDelivery(), direccionEntrega: "Unidad Reserva Campestre" }];
    const out = rescuePriceQuestion("que cuesta hasta la unidad de reserva campestre ?", read, true);
    assert.equal(out.confused, false);
    assert.equal(out.entregas[0].direccionEntrega, "Unidad Reserva Campestre");
  });

  it("lo que no es una pregunta de precio sigue como lo dijo el modelo", () => {
    const confusing = rescuePriceQuestion("quiero hablar con una persona", [], true);
    assert.equal(confusing.confused, true);
    assert.deepEqual(confusing.entregas, []);
    const angry = rescuePriceQuestion("no me han mandado la moto a la unidad reserva campestre", [], true);
    assert.equal(angry.confused, true);
  });
});
