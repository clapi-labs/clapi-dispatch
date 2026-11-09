import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { insideRing, ringAreaM2, withZoneMinimum, zoneAt, zonesAt, type PriceZoneShape } from "./price-zones";

/** Un cuadrado de `side` grados con la esquina suroeste en (lat, lng). */
const square = (lat: number, lng: number, side: number) => [
  { lat, lng },
  { lat, lng: lng + side },
  { lat: lat + side, lng: lng + side },
  { lat: lat + side, lng },
];

// Un barrio con mínimo, una parte de él con otro mínimo y otra parte sin mínimo.
const BARRIO: PriceZoneShape = { id: 1, name: "Ciudad Jardín", minPrice: 10_000, ring: square(3.36, -76.54, 0.02) };
const PARTE_CARA: PriceZoneShape = { id: 2, name: "Ciudad Jardín alto", minPrice: 14_000, ring: square(3.37, -76.53, 0.005) };
const PARTE_SIN_MINIMO: PriceZoneShape = { id: 3, name: "Ciudad Jardín junto a la Pasoancho", minPrice: null, ring: square(3.362, -76.538, 0.004) };
const OTRA: PriceZoneShape = { id: 4, name: "El Ingenio", minPrice: 8_000, ring: square(3.38, -76.52, 0.01) };
const ZONES = [BARRIO, PARTE_CARA, PARTE_SIN_MINIMO, OTRA];

const EN_EL_BARRIO = { lat: 3.365, lng: -76.53 };
const EN_LA_PARTE_CARA = { lat: 3.372, lng: -76.528 };
const EN_LA_PARTE_SIN_MINIMO = { lat: 3.364, lng: -76.536 };
const FUERA = { lat: 3.45, lng: -76.53 };

/** El precio como lo arma la cotización: tabla por km y zona de la entrega. */
const price = (kmPrice: number | null, point: { lat: number; lng: number }) => withZoneMinimum(kmPrice, zoneAt(point, ZONES));

describe("insideRing", () => {
  it("distingue dentro y fuera, también en un contorno cóncavo", () => {
    assert.equal(insideRing(EN_EL_BARRIO, BARRIO.ring), true);
    assert.equal(insideRing(FUERA, BARRIO.ring), false);
    // Una L: el hueco de la esquina queda fuera.
    const ele = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 1, lng: 2 },
      { lat: 1, lng: 1 },
      { lat: 2, lng: 1 },
      { lat: 2, lng: 0 },
    ];
    assert.equal(insideRing({ lat: 0.5, lng: 1.5 }, ele), true);
    assert.equal(insideRing({ lat: 1.5, lng: 1.5 }, ele), false);
  });
});

describe("ringAreaM2", () => {
  it("mide en metros, sin importar el sentido del contorno", () => {
    // 0.01° en Cali son unos 1.110 m de lado.
    const area = ringAreaM2(square(3.4, -76.5, 0.01));
    assert.ok(area > 1.2e6 && area < 1.25e6, String(area));
    // Al revés cambia el punto de referencia: unos m² de diferencia en 1,2 km².
    assert.ok(Math.abs(ringAreaM2([...square(3.4, -76.5, 0.01)].reverse()) - area) < 50);
  });
});

describe("precio con mínimo por zona", () => {
  it("si la tabla por km da menos, se cobra el mínimo de la zona", () => {
    assert.equal(price(6_000, EN_EL_BARRIO), 10_000);
  });

  it("si la tabla por km da más que el mínimo, se cobra por km", () => {
    assert.equal(price(12_000, EN_EL_BARRIO), 12_000);
  });

  it("fuera de toda zona se cobra exactamente lo de la tabla", () => {
    assert.equal(price(6_000, FUERA), 6_000);
    assert.equal(price(25_000, FUERA), 25_000);
  });

  it("sin tabla por km no hay precio, haya zona o no", () => {
    assert.equal(price(null, EN_EL_BARRIO), null);
    assert.equal(price(null, FUERA), null);
  });
});

describe("zonas dentro de zonas", () => {
  it("manda la más pequeña, aunque su mínimo sea mayor", () => {
    assert.equal(zoneAt(EN_LA_PARTE_CARA, ZONES)?.name, "Ciudad Jardín alto");
    assert.equal(price(6_000, EN_LA_PARTE_CARA), 14_000);
  });

  it("una parte marcada sin mínimo cobra solo por km dentro de un barrio con mínimo", () => {
    assert.equal(zoneAt(EN_LA_PARTE_SIN_MINIMO, ZONES)?.name, "Ciudad Jardín junto a la Pasoancho");
    assert.equal(price(6_000, EN_LA_PARTE_SIN_MINIMO), 6_000);
  });

  it("una parte con un mínimo menor cobra ese mínimo, no el del barrio", () => {
    const barata = { ...PARTE_CARA, minPrice: 7_000 };
    assert.equal(withZoneMinimum(6_000, zoneAt(EN_LA_PARTE_CARA, [BARRIO, barata])), 7_000);
  });

  it("lista todas las zonas del punto, de la más pequeña a la más grande", () => {
    assert.deepEqual(
      zonesAt(EN_LA_PARTE_CARA, ZONES).map((z) => z.id),
      [2, 1],
    );
    assert.deepEqual(zonesAt(FUERA, ZONES), []);
  });

  it("no depende del orden en que vienen las zonas", () => {
    assert.equal(zoneAt(EN_LA_PARTE_CARA, [...ZONES].reverse())?.id, 2);
  });
});

describe("mover el borde", () => {
  it("una entrega que queda afuera vuelve a km; una que queda adentro toma el mínimo", () => {
    const punto = { lat: 3.385, lng: -76.505 }; // al oriente de El Ingenio
    assert.equal(withZoneMinimum(5_000, zoneAt(punto, [OTRA])), 5_000);
    const ampliada = { ...OTRA, ring: square(3.38, -76.52, 0.02) };
    assert.equal(withZoneMinimum(5_000, zoneAt(punto, [ampliada])), 8_000);
    const recortada = { ...OTRA, ring: square(3.38, -76.52, 0.004) };
    assert.equal(withZoneMinimum(5_000, zoneAt({ lat: 3.389, lng: -76.511 }, [recortada])), 5_000);
  });
});
