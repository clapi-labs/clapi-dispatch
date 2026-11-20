import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asksWhoIAm, dayGreeting, firstOfDay, isBareGreeting, onlyAsksWhoIAm, startOfCaliDay, withGreeting } from "./greeting";

/** Una hora de Cali (UTC−5) como Date. */
const cali = (iso: string) => new Date(`${iso}-05:00`);

describe("dayGreeting: según la hora de Cali", () => {
  it("de 00:00 a 11:59, buenos días", () => {
    for (const at of ["2026-11-20T00:00:00", "2026-11-20T06:30:00", "2026-11-20T11:59:59"]) {
      assert.equal(dayGreeting(cali(at)), "¡Buenos días! Gracias por confiar en Express Cali 🙌", at);
    }
  });

  it("de 12:00 a 18:59, buenas tardes", () => {
    for (const at of ["2026-11-20T12:00:00", "2026-11-20T15:00:00", "2026-11-20T18:59:59"]) {
      assert.equal(dayGreeting(cali(at)), "¡Buenas tardes! Gracias por confiar en Express Cali 🙌", at);
    }
  });

  it("de 19:00 a 23:59, buenas noches", () => {
    for (const at of ["2026-11-20T19:00:00", "2026-11-20T23:59:59"]) {
      assert.equal(dayGreeting(cali(at)), "¡Buenas noches! Gracias por confiar en Express Cali 🙌", at);
    }
  });

  it("usa la hora de Cali, no la del servidor (UTC)", () => {
    // 02:00 UTC del 21 son las 21:00 del 20 en Cali.
    assert.match(dayGreeting(new Date("2026-11-21T02:00:00Z")), /^¡Buenas noches!/);
  });
});

describe("firstOfDay: el día es el de Cali", () => {
  const now = cali("2026-11-20T15:00:00");

  it("si nunca se le escribió, es el primero", () => {
    assert.equal(firstOfDay(null, now), true);
  });

  it("si se le escribió ayer (aunque sea a las 23:59), es el primero", () => {
    assert.equal(firstOfDay(cali("2026-11-19T23:59:00"), now), true);
  });

  it("si ya se le escribió hoy, no", () => {
    assert.equal(firstOfDay(cali("2026-11-20T00:01:00"), now), false);
    assert.equal(firstOfDay(cali("2026-11-20T14:59:00"), now), false);
  });

  it("la medianoche es la de Cali: las 8 p. m. de Cali ya son otro día en UTC, pero no aquí", () => {
    assert.equal(startOfCaliDay(cali("2026-11-20T20:00:00")).toISOString(), "2026-11-20T05:00:00.000Z");
    assert.equal(firstOfDay(cali("2026-11-20T08:00:00"), cali("2026-11-20T20:30:00")), false);
  });
});

describe("isBareGreeting", () => {
  it("reconoce saludos sueltos, con emojis, signos y letras alargadas", () => {
    for (const t of ["Hola", "hola!", "Holaaa 👋", "Buenas", "buenas tardes", "Buenos días", "Buen día", "buenas noches, ¿cómo va?", "Hola, buenas.", "Qué más pues", "Saludos", "Buenaaas"]) {
      assert.equal(isBareGreeting(t), true, t);
    }
  });

  it("no confunde un saludo con un pedido o una pregunta", () => {
    for (const t of [
      "Hola, tenemos domi: Marta, 3001234567, Calle 10 # 5-20",
      "buenas, me regalas un domi",
      "hola el pedido ya está listo",
      "todo bien",
      "ok",
      "gracias",
      "Calle 10 # 5-20",
      "",
    ]) {
      assert.equal(isBareGreeting(t), false, t);
    }
  });
});

describe("asksWhoIAm", () => {
  it("reconoce las formas de preguntar con quién se habla", () => {
    for (const t of ["¿Quién eres?", "quien es usted", "¿Con quién hablo?", "con quien tengo el gusto", "¿eres un bot?", "Es un bot?", "usted es una persona?", "¿Qué es esto?", "estoy hablando con un robot?", "quien me escribe?"]) {
      assert.equal(asksWhoIAm(t), true, t);
    }
  });

  it("no lo confunde con el resto de la conversación", () => {
    for (const t of ["el cliente es una persona mayor", "¿quién va por el pedido?", "domi para un bot de cumpleaños", "hola", "¿ya llegó el domi?"]) {
      assert.equal(asksWhoIAm(t), false, t);
    }
  });

  it("sabe si el mensaje solo preguntaba eso o si trae algo más", () => {
    assert.equal(onlyAsksWhoIAm("Buenas, ¿con quién hablo?"), true);
    assert.equal(onlyAsksWhoIAm("¿eres un bot?"), true);
    assert.equal(onlyAsksWhoIAm("¿eres un bot? necesito un domi a la calle 10"), false);
  });
});

describe("withGreeting", () => {
  it("el saludo va arriba, separado por una línea; sin saludo, el texto tal cual", () => {
    assert.equal(withGreeting("¡Hola!", "Texto"), "¡Hola!\n\nTexto");
    assert.equal(withGreeting(null, "Texto"), "Texto");
  });
});
