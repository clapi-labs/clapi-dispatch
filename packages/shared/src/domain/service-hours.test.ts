import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  closedMessage,
  closedNoticeDue,
  closingReminderMessage,
  formatClock,
  isOpen,
  lastOpening,
  minutesLeft,
  normalizeClock,
  parseClock,
} from "./service-hours";

/** Una hora de Cali (UTC−5) del 9 de noviembre de 2026; `day` corre el día. */
const cali = (h: number, m: number, day = 0) => new Date(Date.UTC(2026, 10, 9 + day, h + 5, m));

const NORMAL = { opensAt: "10:00", deadline: "23:30" };
const LATE = { opensAt: "10:00", deadline: "01:30" };

describe("parseClock y normalizeClock", () => {
  it("lee horas de 24 horas", () => {
    assert.equal(parseClock("10:00"), 600);
    assert.equal(parseClock("1:30"), 90);
    assert.equal(parseClock("23:59"), 1439);
  });

  it("rechaza lo que no es una hora", () => {
    for (const bad of ["24:00", "10:60", "10", "diez", "", null, 10]) assert.equal(parseClock(bad), null);
  });

  it("deja la hora siempre como HH:MM", () => {
    assert.equal(normalizeClock("1:30"), "01:30");
    assert.equal(normalizeClock(" 23:30 "), "23:30");
    assert.equal(normalizeClock("25:00"), null);
  });
});

describe("formatClock", () => {
  it("la dice como una persona", () => {
    assert.equal(formatClock("10:00"), "10:00 a. m.");
    assert.equal(formatClock("23:30"), "11:30 p. m.");
    assert.equal(formatClock("01:30"), "1:30 a. m.");
    assert.equal(formatClock("00:15"), "12:15 a. m.");
    assert.equal(formatClock("12:00"), "12:00 m.");
    assert.equal(formatClock("12:45"), "12:45 p. m.");
  });
});

describe("isOpen con límite antes de la medianoche", () => {
  it("atiende entre el inicio y el límite", () => {
    assert.equal(isOpen(cali(10, 0), NORMAL), true);
    assert.equal(isOpen(cali(15, 0), NORMAL), true);
    assert.equal(isOpen(cali(23, 29), NORMAL), true);
  });

  it("no atiende desde el límite ni antes del inicio", () => {
    assert.equal(isOpen(cali(23, 30), NORMAL), false);
    assert.equal(isOpen(cali(23, 40), NORMAL), false);
    assert.equal(isOpen(cali(1, 0), NORMAL), false);
    assert.equal(isOpen(cali(9, 30), NORMAL), false);
  });
});

describe("isOpen con límite después de la medianoche", () => {
  it("la 1:30 a. m. es de esa misma noche", () => {
    assert.equal(isOpen(cali(23, 40), LATE), true);
    assert.equal(isOpen(cali(0, 10), LATE), true);
    assert.equal(isOpen(cali(1, 0), LATE), true);
    assert.equal(isOpen(cali(1, 29), LATE), true);
  });

  it("después del límite no atiende hasta el inicio", () => {
    assert.equal(isOpen(cali(1, 30), LATE), false);
    assert.equal(isOpen(cali(1, 40), LATE), false);
    assert.equal(isOpen(cali(9, 59), LATE), false);
    assert.equal(isOpen(cali(10, 0), LATE), true);
  });

  it("límite igual al inicio: atiende todo el día", () => {
    assert.equal(isOpen(cali(4, 0), { opensAt: "10:00", deadline: "10:00" }), true);
  });
});

describe("minutesLeft", () => {
  it("cuenta hasta el límite, también pasando la medianoche", () => {
    assert.equal(minutesLeft(cali(23, 20), NORMAL), 10);
    assert.equal(minutesLeft(cali(23, 40), LATE), 110);
    assert.equal(minutesLeft(cali(1, 20), LATE), 10);
  });

  it("fuera de horario no queda nada", () => {
    assert.equal(minutesLeft(cali(23, 35), NORMAL), null);
  });
});

describe("lastOpening y closedNoticeDue", () => {
  it("la última apertura es la de hoy o, de madrugada, la de ayer", () => {
    assert.deepEqual(lastOpening(cali(15, 12), "10:00"), cali(10, 0));
    assert.deepEqual(lastOpening(cali(1, 40), "10:00"), cali(10, 0, -1));
    assert.deepEqual(lastOpening(cali(9, 30), "10:00"), cali(10, 0, -1));
  });

  it("el aviso no se repite en la misma noche", () => {
    const first = cali(23, 40);
    assert.equal(closedNoticeDue(first, "10:00", null), true);
    assert.equal(closedNoticeDue(cali(23, 55), "10:00", first), false);
    assert.equal(closedNoticeDue(cali(2, 0, 1), "10:00", first), false);
  });

  it("después de la apertura siguiente, vuelve a salir", () => {
    const first = cali(23, 40);
    assert.equal(closedNoticeDue(cali(23, 40, 1), "10:00", first), true);
  });
});

describe("closedMessage", () => {
  it("de noche espera mañana; antes de abrir, hoy", () => {
    assert.equal(
      closedMessage(cali(23, 40), "10:00"),
      "A esta hora ya no recibimos servicios para tu restaurante 🙏 Te esperamos mañana desde las 10:00 a. m.",
    );
    assert.match(closedMessage(cali(1, 40), "10:00"), /mañana desde las 10:00 a\. m\./);
    assert.match(closedMessage(cali(9, 30), "10:00"), /hoy desde las 10:00 a\. m\./);
  });
});

describe("closingReminderMessage", () => {
  it("dice la hora una sola vez y sin punto doble", () => {
    assert.equal(
      closingReminderMessage("23:30"),
      "⏰ Recibimos servicios hasta las 11:30 p. m. Confirma tu pedido antes de esa hora o ya no lo podremos recibir 🙏",
    );
    assert.doesNotMatch(closingReminderMessage("12:00"), /\.\./);
  });
});
