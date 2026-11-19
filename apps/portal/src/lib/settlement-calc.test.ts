import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { byDay, onDay, summarize, type DeliveredRow } from "./settlement-calc";

const row = (name: string, fee: number, at: string, courierId = 1): DeliveredRow => ({ courierId, courierName: name, deliveryFee: fee, deliveredAt: new Date(at) });

describe("summarize", () => {
  it("sin viajes: todo en cero", () => {
    assert.deepEqual(summarize([]), { total: 0, deliveredCount: 0, averageFee: 0, agencyRate: 0.1, agencyShare: 0, couriers: [] });
  });

  it("agrupa por moto, ordena por lo generado y calcula el 10 %", () => {
    const body = summarize([row("Pedro", 5_000, "2026-11-18T15:00:00Z"), row("Luis", 8_000, "2026-11-18T16:00:00Z", 2), row("Luis", 8_000, "2026-11-18T17:00:00Z", 2)]);
    assert.deepEqual([body.total, body.deliveredCount, body.averageFee, body.agencyShare], [21_000, 3, 7_000, 2_100]);
    assert.deepEqual(body.couriers.map((c) => [c.courierName, c.deliveredCount, c.earned, c.agencyShare]), [["Luis", 2, 16_000, 1_600], ["Pedro", 1, 5_000, 500]]);
  });
});

describe("byDay (semana lunes 16 – domingo 22 de nov de 2026, hora de Colombia)", () => {
  it("siempre siete días, de lunes a domingo, los vacíos en cero", () => {
    const days = byDay([], "2026-11-18");
    assert.equal(days.length, 7);
    assert.equal(days[0].date, "2026-11-16");
    assert.equal(days[6].date, "2026-11-22");
    assert.ok(days.every((d) => d.deliveredCount === 0 && d.total === 0 && d.agencyShare === 0));
  });

  it("reparte por día de Colombia: las 11 p. m. del lunes (04:00 UTC del martes) son del lunes", () => {
    const days = byDay(
      [
        row("A", 5_000, "2026-11-17T04:00:00Z"), // lunes 23:00 Colombia
        row("A", 7_000, "2026-11-17T05:00:00Z"), // martes 00:00 Colombia
      ],
      "2026-11-18",
    );
    assert.deepEqual([days[0].deliveredCount, days[0].total, days[0].agencyShare], [1, 5_000, 500]);
    assert.deepEqual([days[1].deliveredCount, days[1].total], [1, 7_000]);
  });

  it("el cambio de semana: el domingo 23:59 es de esta semana; el lunes 00:00 no", () => {
    const days = byDay(
      [
        row("A", 1_000, "2026-11-23T04:59:59Z"), // domingo 22, 23:59:59 Colombia
        row("A", 9_000, "2026-11-23T05:00:00Z"), // lunes 23: otra semana
        row("A", 3_000, "2026-11-16T04:59:59Z"), // domingo 15: semana anterior
      ],
      "2026-11-18",
    );
    assert.deepEqual(days.map((d) => d.deliveredCount), [0, 0, 0, 0, 0, 0, 1]);
    assert.equal(days[6].total, 1_000);
  });

  it("la suma de los días es la de la semana", () => {
    const rows = [row("A", 5_000, "2026-11-16T20:00:00Z"), row("B", 6_000, "2026-11-18T20:00:00Z", 2), row("A", 7_000, "2026-11-22T20:00:00Z")];
    const days = byDay(rows, "2026-11-20");
    assert.equal(days.reduce((s, d) => s + d.total, 0), summarize(rows).total);
  });
});

describe("onDay", () => {
  it("deja solo los viajes de ese día de Colombia, y por moto agrega bien", () => {
    const rows = [row("A", 5_000, "2026-11-18T10:00:00Z"), row("B", 6_000, "2026-11-19T03:00:00Z", 2), row("A", 7_000, "2026-11-19T05:00:00Z")];
    const wed = onDay(rows, "2026-11-18");
    assert.equal(wed.length, 2, "las 03:00 UTC son las 22:00 del miércoles en Colombia");
    const body = summarize(wed);
    assert.deepEqual(body.couriers.map((c) => [c.courierName, c.earned]), [["B", 6_000], ["A", 5_000]]);
  });
});
