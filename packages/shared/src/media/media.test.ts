import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { mediaConfig, MEDIA_DEFAULTS, type MediaConfig } from "./config";
import { dayFolder, isDayFolder, relativeMediaPath, resolveMediaPath } from "./paths";
import { folderSize, planPurge, purgeMedia, type MediaIndex, type MediaRow } from "./purge";

const MB = 1024 * 1024;
const DAY = 86_400_000;
const NOW = new Date("2026-11-19T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const row = (id: number, ageDays: number, bytes = 50_000): MediaRow => ({ id, path: `${dayFolder(daysAgo(ageDays))}/${id}.webp`, bytes, createdAt: daysAgo(ageDays) });

describe("mediaConfig", () => {
  it("sin variables: 30 días, 3 GB y 75 % de disco", () => {
    const c = mediaConfig({});
    assert.deepEqual([c.retentionDays, c.maxBytes, c.maxDiskPercent], [30, 3072 * MB, 75]);
    assert.deepEqual([MEDIA_DEFAULTS.retentionDays, MEDIA_DEFAULTS.maxMb, MEDIA_DEFAULTS.maxDiskPercent], [30, 3072, 75]);
    assert.ok(path.isAbsolute(c.dir));
  });

  it("lee las variables", () => {
    const c = mediaConfig({ MEDIA_DIR: "/data/media", MEDIA_RETENTION_DAYS: "7", MEDIA_MAX_MB: "500", MEDIA_MAX_DISK_PERCENT: "60" });
    assert.deepEqual([c.dir, c.retentionDays, c.maxBytes, c.maxDiskPercent], ["/data/media", 7, 500 * MB, 60]);
  });

  it("un valor roto, vacío, cero o negativo vuelve al de por defecto", () => {
    for (const bad of ["", "  ", "abc", "0", "-5", "NaN"]) {
      const c = mediaConfig({ MEDIA_RETENTION_DAYS: bad, MEDIA_MAX_MB: bad, MEDIA_MAX_DISK_PERCENT: bad });
      assert.deepEqual([c.retentionDays, c.maxBytes, c.maxDiskPercent], [30, 3072 * MB, 75], JSON.stringify(bad));
    }
  });

  it("los días son enteros de al menos 1 y el porcentaje no pasa de 100", () => {
    assert.equal(mediaConfig({ MEDIA_RETENTION_DAYS: "0.5" }).retentionDays, 1);
    assert.equal(mediaConfig({ MEDIA_RETENTION_DAYS: "7.9" }).retentionDays, 7);
    assert.equal(mediaConfig({ MEDIA_MAX_DISK_PERCENT: "250" }).maxDiskPercent, 100);
  });
});

describe("rutas de las fotos", () => {
  it("una carpeta por día (UTC) y el archivo con su id", () => {
    assert.equal(dayFolder(new Date("2026-11-19T04:59:59Z")), "2026-11-19");
    assert.equal(relativeMediaPath(new Date("2026-11-19T15:00:00Z"), "abc", "webp"), "2026-11-19/abc.webp");
    assert.ok(isDayFolder("2026-11-19"));
    assert.ok(!isDayFolder("2026-11-1"));
    assert.ok(!isDayFolder("tmp"));
  });

  it("resuelve rutas dentro de la carpeta y rechaza las que se salen", () => {
    const dir = path.resolve("/data/media");
    assert.equal(resolveMediaPath(dir, "2026-11-19/a.webp"), path.join(dir, "2026-11-19", "a.webp"));
    for (const bad of ["../etc/passwd", "2026-11-19/../../x", "/etc/passwd", "C:\\Windows\\win.ini", "c:/x", "", "a\0b", ".."]) {
      assert.equal(resolveMediaPath(dir, bad), null, JSON.stringify(bad));
    }
  });

  it("una carpeta hermana con el mismo prefijo no cuenta como dentro", () => {
    assert.equal(resolveMediaPath(path.resolve("/data/media"), "../media-other/a.webp"), null);
  });
});

describe("planPurge — por tiempo", () => {
  const config = { retentionDays: 30, maxBytes: 3072 * MB, maxDiskPercent: 75 };

  it("borra lo que pasó de 30 días y deja lo demás", () => {
    const rows = [row(1, 45), row(2, 31), row(3, 30), row(4, 1)];
    const plan = planPurge({ rows, now: NOW, config, folderBytes: 200_000, disk: null });
    assert.deepEqual(plan.ttl.map((r) => r.id), [1, 2]);
    assert.deepEqual(plan.space, []);
  });

  it("justo en el límite de 30 días todavía se conserva; un milisegundo más, no", () => {
    const edge: MediaRow = { id: 1, path: "x/1.webp", bytes: 1, createdAt: new Date(NOW.getTime() - 30 * DAY) };
    const past: MediaRow = { id: 2, path: "x/2.webp", bytes: 1, createdAt: new Date(NOW.getTime() - 30 * DAY - 1) };
    const plan = planPurge({ rows: [edge, past], now: NOW, config, folderBytes: 2, disk: null });
    assert.deepEqual(plan.ttl.map((r) => r.id), [2]);
  });

  it("respeta los días configurados", () => {
    const rows = [row(1, 8), row(2, 6)];
    const plan = planPurge({ rows, now: NOW, config: { ...config, retentionDays: 7 }, folderBytes: 100, disk: null });
    assert.deepEqual(plan.ttl.map((r) => r.id), [1]);
  });

  it("sin fotos no hace nada", () => {
    assert.deepEqual(planPurge({ rows: [], now: NOW, config, folderBytes: 0, disk: null }), { ttl: [], space: [] });
  });
});

describe("planPurge — por espacio", () => {
  const config = { retentionDays: 30, maxBytes: 3 * MB, maxDiskPercent: 75 };

  it("bajo el tope no borra nada", () => {
    const rows = [row(1, 5, MB), row(2, 4, MB)];
    assert.deepEqual(planPurge({ rows, now: NOW, config, folderBytes: 2 * MB, disk: null }).space, []);
  });

  it("pasado el tope de la carpeta, borra de la más vieja a la más nueva, solo hasta quedar debajo", () => {
    const rows = [row(4, 1, MB), row(1, 20, MB), row(3, 5, MB), row(2, 10, MB), row(5, 0, MB)];
    const plan = planPurge({ rows, now: NOW, config, folderBytes: 5 * MB, disk: null });
    assert.deepEqual(plan.space.map((r) => r.id), [1, 2], "5 MB con tope de 3 MB: salen las dos más viejas");
  });

  it("lo que ya borra el tiempo cuenta antes de mirar el espacio", () => {
    const rows = [row(1, 40, 2 * MB), row(2, 5, MB), row(3, 1, MB)];
    const plan = planPurge({ rows, now: NOW, config, folderBytes: 4 * MB, disk: null });
    assert.deepEqual(plan.ttl.map((r) => r.id), [1]);
    assert.deepEqual(plan.space, [], "al irse la de 40 días quedan 2 MB, bajo el tope de 3 MB");
  });

  it("la carpeta pesa más que las filas (archivos huérfanos): se borran más fotos hasta compensar", () => {
    const rows = [row(1, 3, MB), row(2, 2, MB), row(3, 1, MB)];
    const plan = planPurge({ rows, now: NOW, config, folderBytes: 5 * MB, disk: null });
    assert.deepEqual(plan.space.map((r) => r.id), [1, 2]);
  });

  it("si ni borrando todo se baja del tope, borra todo lo que hay y para", () => {
    const rows = [row(1, 3, MB), row(2, 2, MB)];
    const plan = planPurge({ rows, now: NOW, config, folderBytes: 10 * MB, disk: null });
    assert.deepEqual(plan.space.map((r) => r.id), [1, 2]);
  });

  it("empate de fecha: sale primero el de menor id", () => {
    const at = daysAgo(2);
    const rows: MediaRow[] = [3, 1, 2].map((id) => ({ id, path: `p/${id}.webp`, bytes: MB, createdAt: at }));
    const plan = planPurge({ rows, now: NOW, config: { ...config, maxBytes: MB }, folderBytes: 3 * MB, disk: null });
    assert.deepEqual(plan.space.map((r) => r.id), [1, 2]);
  });
});

describe("planPurge — por uso del disco (75 %)", () => {
  const config = { retentionDays: 30, maxBytes: 3072 * MB, maxDiskPercent: 75 };
  const disk = (usedMb: number) => ({ usedBytes: usedMb * MB, totalBytes: 1000 * MB });

  it("disco en 74,9 %: nada", () => {
    const rows = [row(1, 5, 10 * MB)];
    assert.deepEqual(planPurge({ rows, now: NOW, config, folderBytes: 10 * MB, disk: disk(749) }).space, []);
  });

  it("disco en 76 %: borra lo más viejo hasta bajar de 75 %", () => {
    const rows = [row(1, 20, 5 * MB), row(2, 10, 5 * MB), row(3, 1, 5 * MB)];
    const plan = planPurge({ rows, now: NOW, config, folderBytes: 15 * MB, disk: disk(760) });
    assert.deepEqual(plan.space.map((r) => r.id), [1, 2], "760 → 755 → 750 MB de 1000: ya no pasa de 75 %");
  });

  it("exactamente 75 % no se borra (solo cuando lo supera)", () => {
    const rows = [row(1, 20, MB)];
    assert.deepEqual(planPurge({ rows, now: NOW, config, folderBytes: MB, disk: disk(750) }).space, []);
  });

  it("lo que borró el tiempo también baja el uso del disco", () => {
    const rows = [row(1, 40, 20 * MB), row(2, 1, MB)];
    const plan = planPurge({ rows, now: NOW, config, folderBytes: 21 * MB, disk: disk(760) });
    assert.deepEqual(plan.ttl.map((r) => r.id), [1]);
    assert.deepEqual(plan.space, [], "760 - 20 = 740 MB: bajo el 75 %");
  });

  it("MEDIA_MAX_DISK_PERCENT configurable, y sin medición del disco no se aplica", () => {
    const rows = [row(1, 20, 5 * MB), row(2, 10, 5 * MB)];
    assert.deepEqual(planPurge({ rows, now: NOW, config: { ...config, maxDiskPercent: 50 }, folderBytes: 10 * MB, disk: disk(600) }).space.length, 2);
    assert.deepEqual(planPurge({ rows, now: NOW, config, folderBytes: 10 * MB, disk: null }).space, []);
  });
});

describe("purgeMedia (carpeta temporal)", () => {
  let dir: string;
  let config: MediaConfig;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-test-"));
    config = { dir, retentionDays: 30, maxBytes: 3 * MB, maxDiskPercent: 75 };
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Escribe un archivo de `bytes` en la carpeta del día de la fila. */
  async function put(r: MediaRow) {
    const full = path.join(dir, r.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.alloc(r.bytes, 1));
  }
  const exists = (rel: string) => fs.stat(path.join(dir, rel)).then(() => true, () => false);

  function fakeIndex(rows: MediaRow[]) {
    const expired: { ids: number[]; reason: string; at: Date }[] = [];
    const index: MediaIndex = {
      listStored: async () => rows.filter((r) => !expired.some((e) => e.ids.includes(r.id))),
      markExpired: async (ids, reason, at) => void expired.push({ ids, reason, at }),
    };
    return { index, expired };
  }
  const noDisk = async () => null;

  it("borra los archivos con más de 30 días, los marca ttl y deja los recientes", async () => {
    const rows = [row(1, 45, 1000), row(2, 31, 1000), row(3, 2, 1000)];
    for (const r of rows) await put(r);
    const { index, expired } = fakeIndex(rows);

    const result = await purgeMedia({ index, config, now: NOW, measureDisk: noDisk });

    assert.deepEqual([result.ttl, result.space, result.freedBytes], [2, 0, 2000]);
    assert.deepEqual(expired.map((e) => [e.ids.sort(), e.reason]), [[[1, 2], "ttl"]]);
    assert.equal(await exists(rows[0].path), false);
    assert.equal(await exists(rows[1].path), false);
    assert.equal(await exists(rows[2].path), true);
  });

  it("respeta el tope de espacio: borra las más viejas hasta bajar de 3 MB y las marca space", async () => {
    const rows = [row(1, 10, MB), row(2, 8, MB), row(3, 6, MB), row(4, 4, MB), row(5, 2, MB)];
    for (const r of rows) await put(r);
    const { index, expired } = fakeIndex(rows);

    const result = await purgeMedia({ index, config, now: NOW, measureDisk: noDisk });

    assert.deepEqual([result.ttl, result.space], [0, 2]);
    assert.deepEqual(expired.map((e) => [e.ids, e.reason]), [[[1, 2], "space"]]);
    assert.equal(await folderSize(dir), 3 * MB);
    assert.equal(await exists(rows[0].path), false);
    assert.equal(await exists(rows[4].path), true);
  });

  it("por uso de disco: baja de 75 % borrando lo más viejo", async () => {
    const rows = [row(1, 10, MB), row(2, 5, MB), row(3, 1, MB)];
    for (const r of rows) await put(r);
    const { index } = fakeIndex(rows);
    const measureDisk = async () => ({ usedBytes: 76 * MB, totalBytes: 100 * MB });

    const result = await purgeMedia({ index, config: { ...config, maxBytes: 100 * MB }, now: NOW, measureDisk });

    assert.equal(result.space, 1, "76 → 75 MB de 100: ya no pasa de 75 %");
    assert.equal(await exists(rows[0].path), false);
    assert.equal(await exists(rows[1].path), true);
  });

  it("si el archivo ya no estaba, igual marca la fila; si no se puede borrar, la deja sin marcar", async () => {
    const rows = [row(1, 40, 1000), row(2, 41, 1000)];
    await put(rows[1]); // el 1 ya no está en disco
    const { index, expired } = fakeIndex(rows);
    await purgeMedia({ index, config, now: NOW, measureDisk: noDisk });
    assert.deepEqual(expired[0].ids.sort(), [1, 2]);

    // Un directorio con el nombre del archivo: rm sin recursive falla → no se marca.
    const stuck = row(9, 40, 10);
    await fs.mkdir(path.join(dir, stuck.path), { recursive: true });
    await fs.writeFile(path.join(dir, stuck.path, "x"), "x");
    const second = fakeIndex([stuck]);
    const quiet = console.error;
    console.error = () => {};
    try {
      const result = await purgeMedia({ index: second.index, config, now: NOW, measureDisk: noDisk });
      assert.equal(result.ttl, 0);
      assert.deepEqual(second.expired, []);
    } finally {
      console.error = quiet;
    }
  });

  it("una ruta que se sale de la carpeta nunca se toca", async () => {
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.txt`);
    await fs.writeFile(outside, "no me borres");
    const evil: MediaRow = { id: 1, path: `../${path.basename(outside)}`, bytes: 12, createdAt: daysAgo(90) };
    const { index } = fakeIndex([evil]);
    try {
      await purgeMedia({ index, config, now: NOW, measureDisk: noDisk });
      assert.equal(await fs.readFile(outside, "utf8"), "no me borres");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("quita las carpetas de días viejos enteras (también lo huérfano) y las que quedan vacías", async () => {
    const old = daysAgo(45);
    const orphan = path.join(dir, dayFolder(old), "huerfano.webp");
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.writeFile(orphan, "x");
    const fresh = row(1, 2, 1000);
    await put(fresh);
    await fs.mkdir(path.join(dir, "2026-11-10"), { recursive: true }); // vacía y reciente
    const { index } = fakeIndex([fresh]);

    const result = await purgeMedia({ index, config, now: NOW, measureDisk: noDisk });

    assert.equal(result.foldersRemoved, 1);
    assert.equal(await exists(path.join(dayFolder(old), "huerfano.webp")), false);
    assert.equal(await exists(fresh.path), true);
    assert.equal(await exists("2026-11-10"), false, "una carpeta de día vacía se quita");
  });

  it("carpeta inexistente o vacía: no falla", async () => {
    const { index } = fakeIndex([]);
    const missing = { ...config, dir: path.join(dir, "no-existe") };
    assert.deepEqual(await purgeMedia({ index, config: missing, now: NOW, measureDisk: noDisk }), { ttl: 0, space: 0, freedBytes: 0, foldersRemoved: 0 });
  });

  it("es idempotente: una segunda pasada no encuentra nada que borrar", async () => {
    const rows = [row(1, 45, 1000), row(2, 2, 1000)];
    for (const r of rows) await put(r);
    const { index } = fakeIndex(rows);
    await purgeMedia({ index, config, now: NOW, measureDisk: noDisk });
    const again = await purgeMedia({ index, config, now: NOW, measureDisk: noDisk });
    assert.deepEqual([again.ttl, again.space], [0, 0]);
  });
});
