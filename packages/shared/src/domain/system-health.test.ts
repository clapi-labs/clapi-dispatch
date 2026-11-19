import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diskAlertLevel, diskAlertMessage, diskLevel, diskUsageFromStatfs, formatBytes } from "./system-health";

const GB = 1024 ** 3;

describe("diskLevel: cuándo avisa el disco", () => {
  it("bien hasta el 75 %, advertencia hasta el 85 %, crítico desde ahí", () => {
    assert.equal(diskLevel(10), "ok");
    assert.equal(diskLevel(74.9), "ok");
    assert.equal(diskLevel(75), "warning");
    assert.equal(diskLevel(84.9), "warning");
    assert.equal(diskLevel(85), "critical");
    assert.equal(diskLevel(100), "critical");
  });
});

describe("diskAlertLevel: una alerta no se apaga y prende sola", () => {
  it("sin alerta previa es igual a diskLevel", () => {
    for (const pct of [50, 74, 75, 80, 85, 95]) assert.equal(diskAlertLevel(pct, "ok"), diskLevel(pct), String(pct));
  });

  it("la advertencia se mantiene hasta bajar dos puntos del 75 %", () => {
    assert.equal(diskAlertLevel(74, "warning"), "warning");
    assert.equal(diskAlertLevel(73, "warning"), "warning");
    assert.equal(diskAlertLevel(72.9, "warning"), "ok");
  });

  it("el crítico se mantiene hasta bajar dos puntos del 85 %; después queda la advertencia", () => {
    assert.equal(diskAlertLevel(84, "critical"), "critical");
    assert.equal(diskAlertLevel(82.9, "critical"), "warning");
    assert.equal(diskAlertLevel(73.5, "critical"), "warning");
    assert.equal(diskAlertLevel(60, "critical"), "ok");
  });
});

describe("diskUsageFromStatfs", () => {
  it("lo reservado para root cuenta como usado, igual que df", () => {
    // 38 GB de disco, 24 GB libres para root y 22 GB para un proceso normal.
    const bsize = 4096;
    const blocks = (38 * GB) / bsize;
    const disk = diskUsageFromStatfs("/", { bsize, blocks, bfree: (24 * GB) / bsize, bavail: (22 * GB) / bsize });
    assert.equal(disk.total, 38 * GB);
    assert.equal(disk.used, 14 * GB);
    assert.equal(disk.free, 22 * GB);
    assert.equal(disk.usedPct, 38.9);
  });

  it("un disco vacío o raro no divide por cero", () => {
    assert.equal(diskUsageFromStatfs("/", { bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }).usedPct, 0);
  });
});

describe("formatBytes", () => {
  it("en la unidad que corresponde, con coma", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1,5 kB");
    assert.equal(formatBytes(24 * GB), "24,0 GB");
  });
});

describe("diskAlertMessage", () => {
  const disk = { path: "/", total: 38 * GB, used: 30 * GB, free: 8 * GB, usedPct: 78.9 };

  it("la advertencia es naranja y lleva a /salud", () => {
    const m = diskAlertMessage(disk, "warning", new Date(1000));
    assert.equal(m.severity, "attention");
    assert.match(m.title, /Disco al 78,9 %/);
    assert.match(m.body, /8,0 GB libres de 38,0 GB/);
    assert.equal(m.url, "/salud");
    assert.equal(m.tag, "disk");
    assert.equal(m.at, 1000);
  });

  it("el crítico es rojo", () => {
    assert.equal(diskAlertMessage({ ...disk, usedPct: 90 }, "critical").severity, "critical");
  });
});
