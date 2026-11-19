import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

import { PgDialect } from "drizzle-orm/pg-core";

import { CHAT_HELP_COOLDOWN_MIN } from "../domain/alerts";
import { ALERT_SOURCES, chatHelpPushCondition, needsHelpCondition } from "./push";

describe("fuentes de alertas al celular", () => {
  const kinds = ALERT_SOURCES.map((s) => s.kind);

  it("no hay aviso por moto asignada, pedido sin moto, «Voy en camino» ni salida de la entrega", () => {
    for (const noisy of ["trip_assigned", "pending_late", "seen_late", "left_delivery"]) assert.ok(!kinds.includes(noisy), noisy);
  });

  it("están los bloqueos reales y las emergencias", () => {
    for (const kind of ["disk_full", "chat_help", "courier_emergency", "customer_no_answer", "pickup_late", "delivery_late", "return_late", "datafono_late", "datafono_closing", "debt_claim"]) {
      assert.ok(kinds.includes(kind), kind);
    }
    assert.equal(new Set(kinds).size, kinds.length, "cada fuente con su propio kind");
  });
});

describe("chat_help: enfriamiento tras la central", () => {
  const dialect = new PgDialect();
  const render = (c: ReturnType<typeof needsHelpCondition>) => dialect.sqlToQuery(c);

  it("el celular espera 5 min tras el último mensaje de la central; el portal no", () => {
    assert.equal(CHAT_HELP_COOLDOWN_MIN, 5);
    const push = render(chatHelpPushCondition());
    assert.match(push.sql, /role = 'agent'/);
    assert.match(push.sql, /make_interval\(mins =>/);
    assert.ok(push.params.includes(CHAT_HELP_COOLDOWN_MIN));
    // La burbuja del portal sigue siendo `needsHelpCondition`, sin enfriamiento.
    assert.doesNotMatch(render(needsHelpCondition()).sql, /make_interval/);
  });
});

describe("service worker: ícono, vibración y permanencia según la severidad", () => {
  function show(data: object) {
    const shown: { title: string; options: Record<string, unknown> }[] = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const self = {
      addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
      registration: { showNotification: (title: string, options: Record<string, unknown>) => (shown.push({ title, options }), Promise.resolve()) },
      clients: { claim: () => {} },
      skipWaiting: () => {},
      location: { origin: "https://x.test" },
    };
    vm.runInNewContext(readFileSync(new URL("../../../../apps/portal/public/sw.js", import.meta.url), "utf8"), { self, URL, Date, JSON, Boolean });
    handlers.push({ data: { json: () => data }, waitUntil: () => {} });
    return shown[0];
  }

  it("naranja: ícono naranja, vibración normal, se puede descartar", () => {
    const { options } = show({ title: "t", body: "b", severity: "attention", tag: "a" });
    assert.equal(options.icon, "/icons/alert-orange-192.png");
    assert.deepEqual([...(options.vibrate as number[])], [200, 100, 200]);
    assert.equal(options.requireInteraction, false);
  });

  it("rojo: ícono rojo, vibración insistente, se queda hasta tocarla", () => {
    const { options } = show({ title: "t", body: "b", severity: "critical", tag: "a" });
    assert.equal(options.icon, "/icons/alert-red-192.png");
    assert.deepEqual([...(options.vibrate as number[])], [350, 120, 350, 120, 450]);
    assert.equal(options.requireInteraction, true);
  });

  it("sin severidad cae en naranja", () => {
    assert.equal(show({ title: "t" }).options.icon, "/icons/alert-orange-192.png");
  });
});

describe("íconos de alerta", () => {
  it("los PNG existen", () => {
    for (const f of ["alert-orange-192.png", "alert-red-192.png"]) {
      const png = readFileSync(new URL(`../../../../apps/portal/public/icons/${f}`, import.meta.url));
      assert.equal(png.subarray(1, 4).toString(), "PNG");
    }
  });
});
