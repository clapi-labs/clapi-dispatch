import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampScale, clampView, DOUBLE_TAP_SCALE, FIT, fitSize, MAX_SCALE, MIN_SCALE, toggleZoom, zoomAt } from "./zoom";

const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} ≠ ${expected}`);

const BOX = { w: 1000, h: 600 };

describe("fitSize", () => {
  it("ajusta la foto a la caja sin deformarla", () => {
    assert.deepEqual(fitSize({ w: 1000, h: 600 }, { w: 1200, h: 800 }), { w: 900, h: 600 });
    const narrow = fitSize({ w: 400, h: 800 }, { w: 1200, h: 800 });
    near(narrow.w, 400);
    near(narrow.h, 800 / 3);
  });

  it("no agranda una foto chica más de su tamaño natural", () => {
    assert.deepEqual(fitSize(BOX, { w: 300, h: 200 }), { w: 300, h: 200 });
  });

  it("sin tamaños válidos devuelve cero (todavía no cargó)", () => {
    assert.deepEqual(fitSize(BOX, { w: 0, h: 0 }), { w: 0, h: 0 });
    assert.deepEqual(fitSize({ w: 0, h: 0 }, { w: 100, h: 100 }), { w: 0, h: 0 });
  });
});

describe("clampScale", () => {
  it("entre 1× y 6×", () => {
    assert.equal(clampScale(0.2), MIN_SCALE);
    assert.equal(clampScale(99), MAX_SCALE);
    assert.equal(clampScale(2.5), 2.5);
  });

  it("un valor roto vuelve a 1×", () => {
    assert.equal(clampScale(Number.NaN), MIN_SCALE);
    assert.equal(clampScale(Number.POSITIVE_INFINITY), MIN_SCALE);
  });
});

describe("clampView", () => {
  const fitted = { w: 900, h: 600 };

  it("sin zoom la foto no se mueve de su sitio", () => {
    assert.deepEqual(clampView({ scale: 1, x: 80, y: -40 }, BOX, { w: 800, h: 500 }), { scale: 1, x: 0, y: 0 });
  });

  it("con zoom se puede mover solo hasta que su borde toque el de la caja", () => {
    // A 2×: 1800 px de ancho en una caja de 1000 → sobran 800, 400 a cada lado.
    assert.deepEqual(clampView({ scale: 2, x: 999, y: 0 }, BOX, fitted), { scale: 2, x: 400, y: 0 });
    assert.equal(clampView({ scale: 2, x: -999, y: 0 }, BOX, fitted).x, -400);
    assert.equal(clampView({ scale: 2, x: 0, y: 999 }, BOX, fitted).y, 300, "1200 de alto en 600 → 300 a cada lado");
  });

  it("si la foto cabe en un eje, en ese eje no se mueve", () => {
    const narrow = { w: 300, h: 600 };
    assert.equal(clampView({ scale: 2, x: 100, y: 0 }, BOX, narrow).x, 0, "600 de ancho en 1000: cabe");
  });
});

describe("zoomAt", () => {
  const fitted = { w: 900, h: 600 };

  it("acercar deja quieto el punto que está bajo el cursor", () => {
    const point = { x: 150, y: 40 };
    const before = FIT;
    const after = zoomAt(before, 2, point, BOX, fitted);
    // El punto de la foto bajo el cursor: u = (p - t) / s. Antes y después tiene que ser el mismo.
    near((point.x - after.x) / after.scale, (point.x - before.x) / before.scale, "x");
    near((point.y - after.y) / after.scale, (point.y - before.y) / before.scale, "y");
    assert.equal(after.scale, 2);
  });

  it("acercar desde el centro no mueve la foto", () => {
    assert.deepEqual(zoomAt(FIT, 3, { x: 0, y: 0 }, BOX, fitted), { scale: 3, x: 0, y: 0 });
  });

  it("no pasa del máximo ni del mínimo", () => {
    assert.equal(zoomAt(FIT, 100, { x: 0, y: 0 }, BOX, fitted).scale, MAX_SCALE);
    assert.equal(zoomAt({ scale: 2, x: 0, y: 0 }, 0.1, { x: 0, y: 0 }, BOX, fitted).scale, MIN_SCALE);
  });

  it("al volver a 1× la foto se recentra", () => {
    const zoomedIn = zoomAt(FIT, 3, { x: 300, y: 100 }, BOX, fitted);
    assert.notDeepEqual([zoomedIn.x, zoomedIn.y], [0, 0]);
    assert.deepEqual(zoomAt(zoomedIn, 1, { x: 300, y: 100 }, BOX, fitted), FIT);
  });

  it("acercar cerca del borde no deja un hueco: queda dentro de lo permitido", () => {
    const corner = zoomAt(FIT, 4, { x: -480, y: -290 }, BOX, fitted);
    const limited = clampView(corner, BOX, fitted);
    assert.deepEqual(corner, limited);
  });
});

describe("toggleZoom (doble toque)", () => {
  const fitted = { w: 900, h: 600 };

  it("sin zoom, acerca a 2,5× donde se tocó", () => {
    const view = toggleZoom(FIT, { x: 100, y: 50 }, BOX, fitted);
    assert.equal(view.scale, DOUBLE_TAP_SCALE);
    near((100 - view.x) / view.scale, 100, "el punto tocado sigue bajo el dedo");
  });

  it("con zoom, vuelve a ajustar", () => {
    assert.deepEqual(toggleZoom({ scale: 3, x: 50, y: 20 }, { x: 0, y: 0 }, BOX, fitted), FIT);
  });
});
