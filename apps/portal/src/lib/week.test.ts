import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addDays, bogotaDate, dayStart, longDate, parseYmd, shortDate, weekdayIndex, weekRange, weekStart } from "./week";

describe("fechas de calendario", () => {
  it("valida el formato y que el día exista", () => {
    assert.deepEqual(parseYmd("2026-11-18"), { y: 2026, m: 11, d: 18 });
    assert.equal(parseYmd("2026-02-30"), null);
    assert.equal(parseYmd("2026-13-01"), null);
    assert.equal(parseYmd("2026-1-1"), null);
    assert.equal(parseYmd("hoy"), null);
    assert.equal(parseYmd(""), null);
    assert.equal(parseYmd(null), null);
    assert.ok(parseYmd("2028-02-29"), "2028 es bisiesto");
    assert.equal(parseYmd("2027-02-29"), null);
  });

  it("suma días cruzando mes y año", () => {
    assert.equal(addDays("2026-11-30", 1), "2026-12-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2027-01-01", -1), "2026-12-31");
    assert.equal(addDays("2028-02-28", 2), "2028-03-01");
  });

  it("el día de la semana: 0 = lunes … 6 = domingo", () => {
    assert.equal(weekdayIndex("2024-01-01"), 0, "2024-01-01 fue lunes");
    assert.equal(weekdayIndex("2026-11-18"), 2, "miércoles");
    assert.equal(weekdayIndex("2026-11-22"), 6, "domingo");
    assert.equal(weekdayIndex("1969-12-29"), 0, "antes de 1970 también");
  });

  it("textos cortos y largos", () => {
    assert.equal(shortDate("2026-11-18"), "18 nov");
    assert.equal(shortDate("2026-01-05"), "5 ene");
    assert.equal(longDate("2026-11-16"), "Lunes 16 nov");
    assert.equal(longDate("2026-11-22"), "Domingo 22 nov");
  });
});

describe("día de Colombia de un instante (UTC−5)", () => {
  it("las 23:59:59.999 de Colombia siguen siendo de ese día; la medianoche ya es del siguiente", () => {
    assert.equal(bogotaDate(Date.parse("2026-11-19T04:59:59.999Z")), "2026-11-18");
    assert.equal(bogotaDate(Date.parse("2026-11-19T05:00:00.000Z")), "2026-11-19");
  });

  it("la 1 a. m. UTC todavía es el día anterior en Colombia", () => {
    assert.equal(bogotaDate(Date.parse("2026-11-19T01:00:00Z")), "2026-11-18");
    assert.equal(bogotaDate(new Date("2026-11-18T05:00:00Z")), "2026-11-18");
  });

  it("el cambio de año también se mide en Colombia", () => {
    assert.equal(bogotaDate(Date.parse("2027-01-01T04:59:59Z")), "2026-12-31");
    assert.equal(bogotaDate(Date.parse("2027-01-01T05:00:00Z")), "2027-01-01");
  });

  it("el inicio de un día es 05:00 UTC", () => {
    assert.equal(dayStart("2026-11-18").toISOString(), "2026-11-18T05:00:00.000Z");
  });
});

describe("semana de lunes a domingo", () => {
  it("cualquier día de la semana lleva al mismo lunes", () => {
    for (const d of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]) {
      assert.equal(weekStart(d), "2026-11-16", d);
    }
    assert.equal(weekStart("2026-11-23"), "2026-11-23", "el lunes siguiente abre otra semana");
  });

  it("la semana que cruza el fin de año", () => {
    const week = weekRange("2027-01-01");
    assert.equal(week.start, "2026-12-28");
    assert.equal(week.end, "2027-01-03");
    assert.deepEqual(week.days.map((d) => d.date), ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  });

  it("siete días contiguos: cada uno termina donde empieza el siguiente", () => {
    const week = weekRange("2026-11-18");
    assert.equal(week.days.length, 7);
    assert.deepEqual(week.days.map((d) => d.index), [0, 1, 2, 3, 4, 5, 6]);
    for (let i = 0; i < 6; i++) assert.equal(week.days[i].to.getTime(), week.days[i + 1].from.getTime());
    for (const d of week.days) assert.equal(d.to.getTime() - d.from.getTime(), 86400_000);
  });

  it("de lunes 00:00 a domingo 23:59:59.999 de Colombia, sin desfase por UTC", () => {
    const week = weekRange("2026-11-18");
    assert.equal(week.from.toISOString(), "2026-11-16T05:00:00.000Z");
    assert.equal(week.to.toISOString(), "2026-11-23T05:00:00.000Z");
    assert.equal(bogotaDate(week.to.getTime() - 1), "2026-11-22", "el último milisegundo es del domingo");
    assert.equal(bogotaDate(week.to), "2026-11-23", "y el siguiente ya es de otra semana");
    assert.equal(bogotaDate(week.from.getTime() - 1), "2026-11-15", "un milisegundo antes del lunes es domingo de la semana anterior");
  });
});
