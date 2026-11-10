import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALERT_FRESH_MS,
  chatHelpMessage,
  deviceLabel,
  formatPhoneCO,
  isFresh,
  pushTopic,
  sessionMaxAge,
  testMessage,
  tripAssignedMessage,
} from "./alerts";

const AT = new Date("2026-11-10T19:30:00Z");

describe("chatHelpMessage", () => {
  it("dice quién pide ayuda y por qué, y abre ese chat", () => {
    const m = chatHelpMessage({
      id: 12,
      phone: "573001112233",
      name: "Pizzería La Esquina",
      reason: "El restaurante pidió hablar con una persona.",
      lastText: "hola??",
      at: AT,
    });
    assert.equal(m.title, "Pizzería La Esquina pide ayuda");
    assert.equal(m.body, "El restaurante pidió hablar con una persona.");
    assert.equal(m.url, "/conversaciones#tel=573001112233");
    assert.equal(m.tag, "chat-12");
    assert.equal(m.at, AT.getTime());
  });

  it("sin nombre usa el teléfono, y sin razón el último mensaje", () => {
    const m = chatHelpMessage({ id: 3, phone: "3001112233", name: null, reason: null, lastText: "  necesito   una moto ya ", at: AT });
    assert.equal(m.title, "+57 300 111 2233 pide ayuda");
    assert.equal(m.body, "necesito una moto ya");
    // El enlace lleva el número con el 57, como `chatHref` del portal.
    assert.equal(m.url, "/conversaciones#tel=573001112233");
  });

  it("un texto largo se corta para que quepa en la notificación", () => {
    const m = chatHelpMessage({ id: 1, phone: "573001112233", name: "X", reason: "a ".repeat(200), lastText: null, at: AT });
    assert.ok(m.body.length <= 160);
    assert.ok(m.body.endsWith("…"));
  });

  it("dos alertas del mismo chat comparten tag: la nueva reemplaza a la anterior", () => {
    const a = chatHelpMessage({ id: 7, phone: "1", name: "A", reason: "uno", lastText: null, at: AT });
    const b = chatHelpMessage({ id: 7, phone: "1", name: "A", reason: "dos", lastText: null, at: AT });
    const other = chatHelpMessage({ id: 8, phone: "1", name: "A", reason: "uno", lastText: null, at: AT });
    assert.equal(a.tag, b.tag);
    assert.notEqual(a.tag, other.tag);
  });
});

describe("tripAssignedMessage", () => {
  it("dice lo mismo que el aviso del portal y abre ese pedido", () => {
    const m = tripAssignedMessage({ id: 55, code: "B07", courierName: "Carlos", restaurant: "Donde Lucho", deliveryAddress: "Calle 5 # 40-12", at: AT });
    assert.equal(m.title, "Moto asignada · B07");
    assert.equal(m.body, "Carlos → Calle 5 # 40-12 (recoge en Donde Lucho)");
    assert.equal(m.url, "/viajes#pedido=55");
    assert.equal(m.tag, "pedido-55");
  });
});

describe("isFresh", () => {
  it("lo de hace poco se avisa; lo viejo entra en silencio", () => {
    assert.equal(isFresh(new Date(AT.getTime() - 60_000), AT), true);
    assert.equal(isFresh(new Date(AT.getTime() - ALERT_FRESH_MS), AT), true);
    assert.equal(isFresh(new Date(AT.getTime() - ALERT_FRESH_MS - 1), AT), false);
  });
});

describe("sessionMaxAge", () => {
  it("12 horas en el navegador, 30 días en el portal instalado", () => {
    assert.equal(sessionMaxAge(false), 12 * 3600);
    assert.equal(sessionMaxAge(true), 30 * 24 * 3600);
    // Pasadas 13 horas, la del celular instalado sigue abierta.
    assert.ok(sessionMaxAge(true) > 13 * 3600);
  });
});

describe("deviceLabel", () => {
  it("reconoce celular y navegador", () => {
    assert.equal(
      deviceLabel("Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"),
      "Android · Chrome",
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"),
      "iPhone · Safari",
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"),
      "Windows · Edge",
    );
    assert.equal(deviceLabel(null), "Navegador");
  });
});

describe("pushTopic", () => {
  it("cabe en el Topic de Web Push", () => {
    assert.equal(pushTopic("chat-12"), "chat-12");
    assert.ok(pushTopic("pedido-" + "9".repeat(40)).length <= 32);
    assert.equal(pushTopic("a b/c"), "abc");
  });
});

describe("formatPhoneCO y testMessage", () => {
  it("formatean como el portal", () => {
    assert.equal(formatPhoneCO("+57 300-111-2233"), "+57 300 111 2233");
    assert.equal(testMessage(AT).url, "/alertas");
  });
});
