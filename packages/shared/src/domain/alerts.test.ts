import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALERT_FRESH_MS,
  chatHelpMessage,
  datafonoLateMessage,
  deviceLabel,
  formatPhoneCO,
  isFresh,
  pushTopic,
  sessionMaxAge,
  courierEmergencyMessage,
  customerNoAnswerMessage,
  datafonoClosingMessage,
  debtClaimMessage,
  deliveryStalledMessage,
  pickupLateMessage,
  testMessage,
  tripBlockage,
} from "./alerts";
import { errandReason } from "./errand";
import { removedCourierReason } from "./fleet-removal";

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
    assert.equal(m.title, "⚠️ Pizzería La Esquina pide ayuda");
    assert.equal(m.severity, "attention");
    assert.equal(m.body, "El restaurante pidió hablar con una persona.");
    assert.equal(m.url, "/conversaciones#tel=573001112233");
    assert.equal(m.tag, "chat-12");
    assert.equal(m.at, AT.getTime());
  });

  it("un encargo se anuncia como encargo, con lo que pidió el restaurante", () => {
    const m = chatHelpMessage({
      id: 21,
      phone: "573001112233",
      name: "Pizzería La Esquina",
      reason: errandReason("necesito que me compren un queso tajado en la salsamentaria"),
      lastText: "necesito que me compren un queso tajado en la salsamentaria",
      at: AT,
    });
    assert.equal(m.title, "🛍️ Encargo · Pizzería La Esquina");
    assert.equal(m.severity, "attention");
    assert.equal(m.body, "«necesito que me compren un queso tajado en la salsamentaria»");
    assert.equal(m.url, "/conversaciones#tel=573001112233");
  });

  it("un domiciliario que la central quitó de la flota y escribió se anuncia como que quiere volver", () => {
    const m = chatHelpMessage({ id: 22, phone: "573001112233", name: "Lauri", reason: removedCourierReason("Lauri Gómez"), lastText: "hola", at: AT });
    assert.equal(m.title, "🛵 Quiere volver a la flota · Lauri");
    assert.equal(m.severity, "attention");
    assert.match(m.body, /^Lauri Gómez pide volver\. Si lo agregas de nuevo en Flota/);
  });

  it("sin nombre usa el teléfono, y sin razón el último mensaje", () => {
    const m = chatHelpMessage({ id: 3, phone: "3001112233", name: null, reason: null, lastText: "  necesito   una moto ya ", at: AT });
    assert.equal(m.title, "⚠️ +57 300 111 2233 pide ayuda");
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

describe("severidad", () => {
  it("el chat de un restaurante es naranja y el de un motorizado, rojo", () => {
    const base = { id: 1, phone: "573001112233", name: "X", reason: "r", lastText: null, at: AT };
    const restaurant = chatHelpMessage(base);
    const courier = chatHelpMessage({ ...base, courier: true });
    assert.equal(restaurant.severity, "attention");
    assert.ok(restaurant.title.startsWith("⚠️ "));
    assert.equal(courier.severity, "critical");
    assert.ok(courier.title.startsWith("🚨 "));
  });

  it("emergencia en Flota, moto que no recoge y entrega o devolución estancada son rojas", () => {
    const trip = { id: 5, code: "B07", courierName: "Carlos", restaurant: "Donde Lucho", deliveryAddress: "Calle 5 # 40-12", at: AT };
    const messages = [
      courierEmergencyMessage({ id: 2, name: "Carlos", at: AT }),
      pickupLateMessage(trip),
      deliveryStalledMessage({ ...trip, returning: false, minutes: 30 }),
      deliveryStalledMessage({ ...trip, returning: true, minutes: 20 }),
    ];
    for (const m of messages) {
      assert.equal(m.severity, "critical");
      assert.ok(m.title.startsWith("🚨 "), m.title);
    }
    assert.equal(messages[0].url, "/flota");
    assert.equal(messages[1].url, "/viajes#pedido=5");
    assert.match(messages[2].title, /Entrega estancada/);
    assert.match(messages[3].title, /Devolución estancada/);
  });

  it("cliente que no contesta, reclamos y datáfonos son naranjas", () => {
    const messages = [
      customerNoAnswerMessage({ id: 5, code: "B07", courierName: "Carlos", deliveryAddress: "Calle 5", at: AT }),
      datafonoLateMessage({ id: 1, courierName: "C", restaurant: "R", tripCode: null, minutes: 30, at: AT }),
      datafonoClosingMessage({ id: 1, courierName: "C", restaurant: "R", tripCode: null, deadline: "10:00 p. m.", at: AT }),
      debtClaimMessage({ id: 1, restaurant: "R", reason: "plata", closing: false, why: "x", at: AT }),
      testMessage(AT),
    ];
    for (const m of messages) {
      assert.equal(m.severity, "attention");
      assert.ok(m.title.startsWith("⚠️ "), m.title);
    }
    assert.equal(messages[0].url, "/viajes#pedido=5");
  });

  it("la prueba ya no habla de motos asignadas", () => {
    assert.doesNotMatch(testMessage(AT).body, /asignad/i);
  });
});

describe("tripBlockage", () => {
  const config = { pickupLateMinutes: 10, deliveryAlertMinutes: 30, returnAlertMinutes: 20 };
  const min = (n: number) => new Date(AT.getTime() + n * 60_000);
  const base = { status: "en_route", assignedAt: AT };

  it("sin moto, o ya cerrado, no hay bloqueo", () => {
    assert.equal(tripBlockage({ ...base, status: "pending" }, config), null);
    assert.equal(tripBlockage({ ...base, status: "delivered" }, config), null);
    assert.equal(tripBlockage({ ...base, status: "cancelled" }, config), null);
    assert.equal(tripBlockage({ ...base, deliveredAt: min(5) }, config), null);
  });

  it("no recoge: desde la asignación, o desde la hora de listo si fue más tarde", () => {
    assert.deepEqual(tripBlockage(base, config), { kind: "pickup_late", at: min(10) });
    assert.deepEqual(tripBlockage({ ...base, readyAt: min(15) }, config), { kind: "pickup_late", at: min(25) });
  });

  it("entrega estancada: desde que recogió, sin cliente que no contesta", () => {
    assert.deepEqual(tripBlockage({ ...base, pickedUpAt: min(12) }, config), { kind: "delivery_late", at: min(42) });
  });

  it("cliente que no contesta: avisa de una vez, y no cuenta como entrega estancada", () => {
    assert.deepEqual(tripBlockage({ ...base, pickedUpAt: min(12), customerWaitAt: min(20) }, config), { kind: "customer_no_answer", at: min(20) });
    // Solo en camino: con la moto apenas asignada no hay espera de cliente.
    assert.equal(tripBlockage({ ...base, status: "assigned", customerWaitAt: min(20) }, config)?.kind, "pickup_late");
  });

  it("devolución estancada: desde que no se entregó", () => {
    assert.deepEqual(tripBlockage({ ...base, pickedUpAt: min(12), undeliveredAt: min(40) }, config), { kind: "return_late", at: min(60) });
    // Viene de esperar al cliente (`customerWaitAt` sigue puesto): ya no es «no contesta».
    assert.deepEqual(tripBlockage({ ...base, pickedUpAt: min(12), customerWaitAt: min(20), undeliveredAt: min(30) }, config), { kind: "return_late", at: min(50) });
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

describe("datafonoLateMessage", () => {
  it("dice quién tiene el datáfono, de qué restaurante y hace cuánto, y abre Pendientes", () => {
    const m = datafonoLateMessage({ id: 7, courierName: "Carlos", restaurant: "Donde Lucho", tripCode: "A-12", minutes: 30, at: AT });
    assert.equal(m.title, "⚠️ Datáfono sin devolver · Donde Lucho");
    assert.equal(m.body, "Carlos lo tiene hace más de 30 min (A-12).");
    assert.equal(m.url, "/pendientes");
    assert.equal(m.tag, "datafono-7");
    assert.equal(m.at, AT.getTime());
  });

  it("sin pedido, sin código", () => {
    const m = datafonoLateMessage({ id: 8, courierName: "Carlos", restaurant: "Donde Lucho", tripCode: null, minutes: 5, at: AT });
    assert.equal(m.body, "Carlos lo tiene hace más de 5 min.");
  });
});
