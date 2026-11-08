import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyDelivery, mergeTripFields, removeDeliveries, type DeliveryDraft, type Interpretation, type OrderDraft } from "./extraction";

type DeliveryFields = Interpretation["entregas"][number];

const ALMENDROS = "Conjunto Residencial Los Almendros, Cl. 15 Nte. #8, Cali, 760045, Valle Del Cauca, CO";

/** Una entrega que llegó como pin: dirección, coordenadas y precio, sin cliente. */
const pin = (address = ALMENDROS): DeliveryDraft => ({
  ...emptyDelivery(),
  direccionEntrega: address,
  direccionUbicada: address,
  ubicacionEntrega: { lat: 3.47, lng: -76.525 },
  cotizacion: { precio: 15000, km: 13.4 },
});

const fields = (patch: Partial<DeliveryFields>): DeliveryFields => ({ ...emptyDelivery(), ...patch });

const draftWith = (...entregas: DeliveryDraft[]): OrderDraft => ({ etapa: "confirmado", origenRestaurante: "prueba", entregas });

const MARTA = { nombreCliente: "Marta Ríos", telefonoCliente: "3009998877", detalleDireccion: "Torre 4 apto 902", listoEnMinutos: 10 };

describe("mergeTripFields", () => {
  it("los datos del cliente que el modelo pone en otra entrega a la misma dirección completan la que ya estaba", () => {
    // Lo que devolvió el modelo el 8/11 con «Esta listo en 10 min, Marta Ríos 3009998877 para torre4 apto 902».
    const merged = mergeTripFields(draftWith(pin()), {
      origenRestaurante: null,
      entregas: [fields({ direccionEntrega: ALMENDROS }), fields({ direccionEntrega: ALMENDROS, ...MARTA })],
    });
    assert.equal(merged.entregas.length, 1);
    assert.equal(merged.entregas[0].nombreCliente, "Marta Ríos");
    assert.equal(merged.entregas[0].detalleDireccion, "Torre 4 apto 902");
    assert.deepEqual(merged.entregas[0].ubicacionEntrega, { lat: 3.47, lng: -76.525 });
  });

  it("también si la entrega de más llega sin dirección", () => {
    const merged = mergeTripFields(draftWith(pin()), {
      origenRestaurante: null,
      entregas: [fields({ listoEnMinutos: 10 }), fields(MARTA)],
    });
    assert.equal(merged.entregas.length, 1);
    assert.equal(merged.entregas[0].telefonoCliente, "3009998877");
  });

  it("la misma dirección escrita distinto cuenta como la misma", () => {
    const merged = mergeTripFields(draftWith(pin()), {
      origenRestaurante: null,
      entregas: [fields({}), fields({ direccionEntrega: "conjunto residencial los almendros cl 15 nte 8 cali 760045 valle del cauca co", ...MARTA })],
    });
    assert.equal(merged.entregas.length, 1);
  });

  it("dos clientes del mismo conjunto siguen siendo dos entregas", () => {
    const ana = { ...pin(), nombreCliente: "Ana Ruiz", detalleDireccion: "Torre 1 apto 101" };
    const merged = mergeTripFields(draftWith(ana), {
      origenRestaurante: null,
      entregas: [fields({}), fields({ direccionEntrega: ALMENDROS, ...MARTA })],
    });
    assert.equal(merged.entregas.length, 2);
    assert.equal(merged.entregas[0].nombreCliente, "Ana Ruiz");
    assert.equal(merged.entregas[1].nombreCliente, "Marta Ríos");
  });

  it("otra dirección es otra entrega", () => {
    const merged = mergeTripFields(draftWith(pin()), {
      origenRestaurante: null,
      entregas: [fields({}), fields({ direccionEntrega: "Cra 98 # 45-30, Valle del Lili" })],
    });
    assert.equal(merged.entregas.length, 2);
  });

  it("sin entregas capturadas, cada una del modelo es nueva", () => {
    const merged = mergeTripFields(draftWith(), {
      origenRestaurante: null,
      entregas: [fields({ direccionEntrega: "Cra 98 # 45-30" }), fields({ direccionEntrega: "Cl 18 # 83-45" })],
    });
    assert.equal(merged.entregas.length, 2);
  });

  it("una puerta suelta («casa 14») no es otra dirección: es el detalle de la entrega", () => {
    const lili = { ...pin("Cra 98 # 45-30, Valle del Lili") };
    const merged = mergeTripFields(draftWith(lili), {
      origenRestaurante: null,
      entregas: [fields({}), fields({ direccionEntrega: "casa 14", nombreCliente: "Ana Ruiz", telefonoCliente: "3001234567" })],
    });
    assert.equal(merged.entregas.length, 1);
    assert.equal(merged.entregas[0].direccionEntrega, "Cra 98 # 45-30, Valle del Lili");
    assert.equal(merged.entregas[0].detalleDireccion, "casa 14");
  });

  it("tampoco sobrescribe la dirección de su misma entrega", () => {
    const merged = mergeTripFields(draftWith(pin()), { origenRestaurante: null, entregas: [fields({ direccionEntrega: "Torre 4 apto 902" })] });
    assert.equal(merged.entregas[0].direccionEntrega, ALMENDROS);
    assert.equal(merged.entregas[0].detalleDireccion, "Torre 4 apto 902");
  });

  it("la puerta repetida en las notas no se guarda como nota", () => {
    const merged = mergeTripFields(draftWith(pin()), {
      origenRestaurante: null,
      entregas: [fields({ ...MARTA, notas: "Para Torre 4 apto 902" })],
    });
    assert.equal(merged.entregas[0].notas, null);
    const kept = mergeTripFields(draftWith(pin()), { origenRestaurante: null, entregas: [fields({ ...MARTA, notas: "Dejar en portería" })] });
    assert.equal(kept.entregas[0].notas, "Dejar en portería");
  });

  it("una dirección con vía o conjunto sigue siendo dirección", () => {
    const merged = mergeTripFields(draftWith(), {
      origenRestaurante: null,
      entregas: [fields({ direccionEntrega: "Torre 2 del Conjunto Los Pinos, Cl 5 # 10-20" }), fields({ direccionEntrega: "Local 3, Cra 50 # 10-20" })],
    });
    assert.deepEqual(
      merged.entregas.map((d) => d.direccionEntrega),
      ["Torre 2 del Conjunto Los Pinos, Cl 5 # 10-20", "Local 3, Cra 50 # 10-20"],
    );
  });

  it("la dirección del pin reescrita en otro orden se conserva, con su punto", () => {
    const merged = mergeTripFields(draftWith(pin()), {
      origenRestaurante: null,
      entregas: [fields({ direccionEntrega: "Cl. 15 Nte. #8, Conjunto Residencial Los Almendros, Cali", ...MARTA })],
    });
    assert.equal(merged.entregas[0].direccionEntrega, ALMENDROS);
    assert.equal(merged.entregas[0].direccionUbicada, ALMENDROS, "no se vuelve a buscar en el mapa");
  });

  it("una dirección corregida sí cambia", () => {
    const merged = mergeTripFields(draftWith(pin()), { origenRestaurante: null, entregas: [fields({ direccionEntrega: "Cl 15 Nte # 8-45, Santa Mónica" })] });
    assert.equal(merged.entregas[0].direccionEntrega, "Cl 15 Nte # 8-45, Santa Mónica");
  });

  it("una entrega que el modelo olvide no se pierde", () => {
    const merged = mergeTripFields(draftWith(pin(), pin("Cra 98 # 45-30")), { origenRestaurante: null, entregas: [fields({ nombreCliente: "Ana" })] });
    assert.equal(merged.entregas.length, 2);
  });
});

describe("removeDeliveries", () => {
  it("«solo es 1» con el pin en una y los datos en otra deja una sola, completa", () => {
    const { draft, removed } = removeDeliveries(draftWith(pin(), { ...pin(), ...MARTA }), [2]);
    assert.equal(removed, true);
    assert.equal(draft.entregas.length, 1);
    assert.equal(draft.entregas[0].nombreCliente, "Marta Ríos");
    assert.equal(draft.entregas[0].listoEnMinutos, 10);
  });

  it("quita la que pide y deja las demás como estaban", () => {
    const pance = pin("Cra 105 # 14-30, Pance");
    const { draft } = removeDeliveries(draftWith(pin(), pance, pin("Cra 98 # 45-30")), [2]);
    assert.deepEqual(
      draft.entregas.map((d) => d.direccionEntrega),
      [ALMENDROS, "Cra 98 # 45-30"],
    );
    assert.equal(draft.entregas[0].nombreCliente, null);
  });

  it("nunca quita todas ni posiciones que no existen", () => {
    const base = draftWith(pin(), pin("Cra 98 # 45-30"));
    assert.equal(removeDeliveries(base, [1, 2]).removed, false);
    assert.equal(removeDeliveries(base, [0, 3, 1.5]).removed, false);
    assert.equal(removeDeliveries(base, []).draft, base);
  });

  it("no cambia el borrador que recibe", () => {
    const base = draftWith(pin(), { ...pin(), ...MARTA });
    removeDeliveries(base, [2]);
    assert.equal(base.entregas.length, 2);
    assert.equal(base.entregas[0].nombreCliente, null);
  });
});
