import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWeeklyReportPdf, pdfMoney, reportFileName } from "./pdf";
import type { Settlement } from "./types";

const data: Settlement = {
  total: 123_000,
  deliveredCount: 20,
  averageFee: 6_150,
  agencyRate: 0.1,
  agencyShare: 12_300,
  couriers: [{ courierId: 1, courierName: "José (Ñandú) \\ Núñez", deliveredCount: 20, earned: 123_000, agencyShare: 12_300 }],
  week: { start: "2026-11-16", end: "2026-11-22" },
  days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${16 + i}`, deliveredCount: i, total: i * 1000, agencyShare: i * 100 })),
  day: null,
};

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("pdfMoney", () => {
  it("separa miles con punto", () => {
    assert.equal(pdfMoney(0), "$ 0");
    assert.equal(pdfMoney(999), "$ 999");
    assert.equal(pdfMoney(1_234_567), "$ 1.234.567");
  });
});

describe("buildWeeklyReportPdf", () => {
  const raw = text(buildWeeklyReportPdf(data, "Express Cali", new Date("2026-11-22T20:00:00Z")));

  it("es un PDF de una sola página, sin CDNs ni fuentes externas", () => {
    assert.ok(raw.startsWith("%PDF-1.4"));
    assert.ok(raw.trimEnd().endsWith("%%EOF"));
    assert.match(raw, /\/Count 1/);
    assert.doesNotMatch(raw, /https?:/);
    assert.match(raw, /\/BaseFont \/Helvetica\b/);
  });

  it("la tabla de referencias apunta a los objetos reales (desplazamientos en bytes)", () => {
    const startxref = Number(/startxref\n(\d+)\n/.exec(raw)![1]);
    assert.equal(raw.slice(startxref, startxref + 4), "xref");
    const entries = [...raw.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    assert.equal(entries.length, 6);
    entries.forEach((off, i) => assert.equal(raw.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  });

  it("el largo declarado del contenido coincide con el real", () => {
    const length = Number(/\/Length (\d+) >>\nstream\n/.exec(raw)![1]);
    const start = raw.indexOf("stream\n") + "stream\n".length;
    assert.equal(raw.slice(start + length, start + length + "\nendstream".length), "\nendstream");
  });

  it("trae la agencia, el rango, los totales, los días y los motorizados", () => {
    for (const piece of ["Express Cali", "Lunes 16 nov", "Domingo 22 nov 2026", "$ 123.000", "$ 12.300", "10 %", "Desglose por d\xeda", "Desglose por motorizado"]) {
      assert.ok(raw.includes(piece), piece);
    }
    assert.ok(raw.includes("Jos\xe9 \\(\xd1and\xfa\\) \\\\ N\xfa\xf1ez"), "tildes en Latin-1 y paréntesis y barra escapados");
  });

  it("exige los datos de la semana", () => {
    assert.throws(() => buildWeeklyReportPdf({ ...data, week: undefined, days: undefined }, "X"));
  });

  it("con muchos motorizados sigue en una página y avisa cuántos faltan", () => {
    const many = { ...data, couriers: Array.from({ length: 40 }, (_, i) => ({ courierId: i, courierName: `Moto ${i}`, deliveredCount: 1, earned: 1000, agencyShare: 100 })) };
    const big = text(buildWeeklyReportPdf(many, "Express Cali"));
    assert.match(big, /\/Count 1/);
    assert.ok(big.includes("y 18 motorizados m\xe1s"));
  });
});

describe("reportFileName", () => {
  it("lleva el lunes de la semana", () => {
    assert.equal(reportFileName("2026-11-16"), "finanzas-semana-2026-11-16.pdf");
  });
});
