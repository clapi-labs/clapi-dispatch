import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { emptyDraft } from "@dispatch/shared";

import { interpretMessage, parseDelivery } from "./extract";

/**
 * Lo que el código hace con lo que devuelve el modelo (#86): la torre y el
 * apartamento van completos a la puerta aunque el modelo los deje en la
 * dirección, y preguntar el precio a un conjunto por su nombre no es confuso.
 * El modelo se reemplaza por una respuesta fija: no se llama a OpenAI.
 */

describe("parseDelivery: la puerta no se queda en la dirección", () => {
  it("el caso real de staging", () => {
    const d = parseDelivery({
      direccionEntrega: "Unidad Reserva campestre, Torre 4 apto 803",
      nombreCliente: "Carlos Gómez",
      telefonoCliente: "300 765 4321",
      listoEnMinutos: 5,
    });
    assert.equal(d.direccionEntrega, "Unidad Reserva campestre");
    assert.equal(d.detalleDireccion, "Torre 4 apto 803");
    assert.equal(d.esConjunto, true);
    assert.equal(d.telefonoCliente, "3007654321");
    assert.equal(d.listoEnMinutos, 5);
  });

  it("si el modelo ya la separó, no cambia", () => {
    const d = parseDelivery({ direccionEntrega: "Unidad Reserva campestre", detalleDireccion: "Torre 4 apto 803", esConjunto: true });
    assert.equal(d.direccionEntrega, "Unidad Reserva campestre");
    assert.equal(d.detalleDireccion, "Torre 4 apto 803");
  });

  it("el nombre del edificio se queda y la puerta sale", () => {
    const d = parseDelivery({ direccionEntrega: "Calle 5 # 66-20, Edificio Torre Alta apto 1203, El Refugio" });
    assert.equal(d.direccionEntrega, "Calle 5 # 66-20, Edificio Torre Alta, El Refugio");
    assert.equal(d.detalleDireccion, "Apto 1203");
  });

  it("la dirección sin tipo de vía se confirma aunque tenga puerta, y la puerta no cuenta como número de la calle", () => {
    assert.equal(parseDelivery({ direccionEntrega: "Unidad Reserva campestre, Torre 4 apto 803" }).dudas, null);
    assert.deepEqual(parseDelivery({ direccionEntrega: "la 42 con 83E-15 apto 302" }).dudas, ["direccionEntrega"]);
  });
});

describe("interpretMessage: el modelo marca confuso o no devuelve la dirección", () => {
  const realFetch = globalThis.fetch;
  const keys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "prueba";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    mock.restoreAll();
    if (keys.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = keys.OPENAI_API_KEY;
  });

  /** El modelo contesta `answer`, y se guarda lo que se le mandó. */
  function modelSays(answer: object) {
    const sent: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    }) as typeof fetch;
    return sent;
  }

  const QUESTION = "hola buenas que cuesta hasta la unidad de reserva campestre ?";

  it("«hola buenas que cuesta hasta la unidad de reserva campestre ?» es una cotización, no un mensaje confuso", async () => {
    // Lo que pasó en staging: el modelo lo marcó confuso y no devolvió ninguna entrega.
    modelSays({ origenRestaurante: null, entregas: [], intencion: null, confuso: true });
    const out = await interpretMessage(QUESTION, emptyDraft());
    assert.equal(out.confused, false);
    assert.equal(out.intent, "cotizar");
    assert.equal(out.fields.entregas.length, 1);
    assert.equal(out.fields.entregas[0].direccionEntrega, "Unidad de reserva campestre");
    assert.equal(out.fields.entregas[0].esConjunto, true);
  });

  it("si el modelo sí leyó la dirección pero lo marcó confuso, tampoco escala", async () => {
    modelSays({ entregas: [{ direccionEntrega: "Unidad Reserva Campestre", esConjunto: true }], intencion: "cotizar", confuso: true });
    const out = await interpretMessage(QUESTION, emptyDraft());
    assert.equal(out.confused, false);
    assert.equal(out.fields.entregas[0].direccionEntrega, "Unidad Reserva Campestre");
  });

  it("lo que de verdad es confuso sigue escalando", async () => {
    modelSays({ entregas: [], intencion: null, confuso: true });
    const out = await interpretMessage("quiero hablar con una persona", emptyDraft());
    assert.equal(out.confused, true);
    assert.deepEqual(out.fields.entregas, []);
  });

  it("un enojo con un conjunto por medio sigue siendo confuso", async () => {
    modelSays({ entregas: [], confuso: true });
    const out = await interpretMessage("llevo una hora esperando la moto para la unidad reserva campestre y nadie responde", emptyDraft());
    assert.equal(out.confused, true);
  });

  it("el mensaje completo del caso real: torre, apto, cliente y tiempo en una sola entrega, con la puerta aparte", async () => {
    modelSays({
      entregas: [{ direccionEntrega: "Unidad Reserva campestre, Torre 4 apto 803", nombreCliente: "Carlos Gómez", telefonoCliente: "3007654321", listoEnMinutos: 5 }],
      intencion: "pedir",
      confuso: false,
    });
    const out = await interpretMessage("Unidad Reserva campestre, Torre 4 Apto 803\nCliente Carlos Gómez 300 765 4321\nen 5", emptyDraft());
    assert.equal(out.fields.entregas.length, 1);
    assert.equal(out.fields.entregas[0].direccionEntrega, "Unidad Reserva campestre");
    assert.equal(out.fields.entregas[0].detalleDireccion, "Torre 4 apto 803");
    assert.equal(out.confused, false);
    assert.equal(out.intent, "pedir");
  });

  it("el prompt le explica al modelo el caso: puerta aparte y precio a un conjunto por su nombre", async () => {
    const sent = modelSays({ entregas: [], confuso: false });
    await interpretMessage("hola", emptyDraft());
    const system = (sent[0] as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "system")!.content;
    assert.match(system, /Unidad Reserva campestre, Torre 4 Apto 803/);
    assert.match(system, /que cuesta hasta la unidad de reserva campestre/);
  });

  it("si OpenAI falla, no se confunde con un mensaje confuso", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 400 })) as typeof fetch;
    const out = await interpretMessage(QUESTION, emptyDraft());
    assert.equal(out.failed, true);
    assert.equal(out.confused, false);
  });
});
