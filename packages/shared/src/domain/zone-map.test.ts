import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PriceZoneShape } from "./price-zones";
import { zoneVerdictAt, type CoverageZoneShape } from "./zone-map";

/** Un cuadrado de `side` grados con la esquina suroeste en (lat, lng). */
const square = (lat: number, lng: number, side: number) => [
  { lat, lng },
  { lat, lng: lng + side },
  { lat: lat + side, lng: lng + side },
  { lat: lat + side, lng },
];

// Ciudad Jardín cobra un mínimo; en su centro hay un sector adonde no se va.
const CIUDAD_JARDIN: PriceZoneShape = { id: 1, name: "Ciudad Jardín", minPrice: 10_000, ring: square(3.36, -76.54, 0.02) };
const PARTE_SIN_MINIMO: PriceZoneShape = { id: 2, name: "Junto a la Pasoancho", minPrice: null, ring: square(3.362, -76.538, 0.004) };
const SECTOR: CoverageZoneShape = { id: 1, name: "Sector del centro", ring: square(3.368, -76.532, 0.004) };
const SUELTA: CoverageZoneShape = { id: 2, name: "Ladera", ring: square(3.45, -76.56, 0.01) };
const PRICES = [CIUDAD_JARDIN, PARTE_SIN_MINIMO];
const COVERAGE = [SECTOR, SUELTA];

describe("zoneVerdictAt", () => {
  it("dentro de una zona sin cobertura no se va, aunque también tenga mínimo", () => {
    const v = zoneVerdictAt({ lat: 3.37, lng: -76.53 }, COVERAGE, PRICES);
    assert.equal(v.kind, "sin_cobertura");
    assert.equal(v.zone?.name, "Sector del centro");
    assert.deepEqual(v.priceZones.map((z) => z.name), ["Ciudad Jardín"]);
  });

  it("en el resto del barrio aplica su mínimo", () => {
    const v = zoneVerdictAt({ lat: 3.375, lng: -76.525 }, COVERAGE, PRICES);
    assert.equal(v.kind, "minimo");
    assert.equal(v.zone?.name, "Ciudad Jardín");
  });

  it("en una parte sin mínimo se cobra por km y dice cuál zona es", () => {
    const v = zoneVerdictAt({ lat: 3.364, lng: -76.536 }, COVERAGE, PRICES);
    assert.equal(v.kind, "km");
    assert.equal(v.zone?.name, "Junto a la Pasoancho");
  });

  it("fuera de toda zona se cobra por km", () => {
    const v = zoneVerdictAt({ lat: 3.42, lng: -76.5 }, COVERAGE, PRICES);
    assert.equal(v.kind, "km");
    assert.equal(v.zone, null);
    assert.deepEqual(v.priceZones, []);
  });

  it("una zona sin cobertura fuera de las de precio también bloquea", () => {
    assert.equal(zoneVerdictAt({ lat: 3.455, lng: -76.555 }, COVERAGE, PRICES).kind, "sin_cobertura");
  });

  it("si cae en dos zonas sin cobertura, nombra la más pequeña", () => {
    const grande: CoverageZoneShape = { id: 3, name: "Todo el sur", ring: square(3.35, -76.55, 0.05) };
    const v = zoneVerdictAt({ lat: 3.37, lng: -76.53 }, [grande, SECTOR], PRICES);
    assert.equal(v.zone?.name, "Sector del centro");
  });
});
