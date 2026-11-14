import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adjustmentZoneAt, fareBreakdown, priceForDistance, validateFareAdjustment, validateFareRanges, type FareRange, type PricedZone } from "./fare";
import { medianKm, zoneCenter, zoneOfPoint } from "./fare-examples";
import { insideRing } from "./service-zones";

/**
 * El precio del domicilio (docs/DIRECCIONES-Y-ZONAS.md, «Precio del
 * domicilio»): tabla por km con cargo por km adicional, más el ajuste de la
 * zona de la entrega. La tabla es la del ejemplo de la propuesta al cliente.
 */
const TABLA: FareRange[] = [
  { upToKm: 1.5, price: 5_000 },
  { upToKm: 3, price: 6_000 },
  { upToKm: 4, price: 7_000 },
  { upToKm: null, price: 7_000, perKm: 1_000 },
];

const square = (lat: number, lng: number, side: number) => [
  { lat, lng },
  { lat, lng: lng + side },
  { lat: lat + side, lng: lng + side },
  { lat: lat + side, lng },
];
const PANCE: PricedZone = { id: 1, name: "Pance", ring: square(3.3, -76.6, 0.04), fareAdjustment: 2_000 };
const CENTRO: PricedZone = { id: 2, name: "Centro", ring: square(3.44, -76.54, 0.02), fareAdjustment: -1_000 };
const ZONES = [PANCE, CENTRO];

describe("priceForDistance: la tabla por km", () => {
  it("cada rango incluye su tope", () => {
    assert.equal(priceForDistance(0, TABLA), 5_000);
    assert.equal(priceForDistance(1.5, TABLA), 5_000);
    assert.equal(priceForDistance(1.6, TABLA), 6_000);
    assert.equal(priceForDistance(3, TABLA), 6_000);
    assert.equal(priceForDistance(3.1, TABLA), 7_000);
  });

  it("4 km exactos es el último rango con tope, sin km adicional", () => {
    assert.equal(priceForDistance(4, TABLA), 7_000);
  });

  it("el km adicional se cobra por fracción: 4,1 km ya paga uno", () => {
    assert.equal(priceForDistance(4.1, TABLA), 8_000);
    assert.equal(priceForDistance(5, TABLA), 8_000);
    assert.equal(priceForDistance(5.1, TABLA), 9_000);
  });

  it("6,2 km cuesta 7.000 + 3 × 1.000", () => {
    assert.equal(priceForDistance(6.2, TABLA), 10_000);
  });

  it("sin decimales de más: 6,2 − 4 no se vuelve 2,2000001 ni 4,3 − 0,3 se pasa de 4", () => {
    assert.equal(priceForDistance(7, TABLA), 10_000);
    const corta: FareRange[] = [{ upToKm: 0.3, price: 1_000 }, { upToKm: null, price: 1_000, perKm: 500 }];
    assert.equal(priceForDistance(4.3, corta), 1_000 + 4 * 500);
  });

  it("una tabla de antes, sin km adicional, cobra el último precio fijo", () => {
    const vieja: FareRange[] = [{ upToKm: 2, price: 5_000 }, { upToKm: null, price: 11_000 }];
    assert.equal(priceForDistance(30, vieja), 11_000);
  });

  it("la tabla vacía no cobra nada", () => {
    assert.equal(priceForDistance(3, []), null);
  });
});

describe("validateFareRanges", () => {
  it("acepta el km adicional en el último tramo y lo deja en 0 si no viene", () => {
    assert.deepEqual(validateFareRanges(TABLA), TABLA);
    assert.deepEqual(validateFareRanges([{ upToKm: 2, price: 5_000 }, { upToKm: null, price: 11_000 }]), [
      { upToKm: 2, price: 5_000 },
      { upToKm: null, price: 11_000, perKm: 0 },
    ]);
  });

  it("rechaza un km adicional negativo o con decimales", () => {
    assert.equal(validateFareRanges([{ upToKm: null, price: 5_000, perKm: -1 }]), null);
    assert.equal(validateFareRanges([{ upToKm: null, price: 5_000, perKm: 1.5 }]), null);
  });

  it("rechaza topes que no crecen o un último tramo con tope", () => {
    assert.equal(validateFareRanges([{ upToKm: 3, price: 1 }, { upToKm: 2, price: 1 }, { upToKm: null, price: 1 }]), null);
    assert.equal(validateFareRanges([{ upToKm: 3, price: 1 }]), null);
  });
});

describe("validateFareAdjustment", () => {
  it("enteros positivos o negativos; vacío es 0", () => {
    assert.equal(validateFareAdjustment(2_000), 2_000);
    assert.equal(validateFareAdjustment(-1_000), -1_000);
    assert.equal(validateFareAdjustment("-1.000"), -1_000);
    assert.equal(validateFareAdjustment(undefined), 0);
    assert.equal(validateFareAdjustment(""), 0);
  });

  it("rechaza decimales, texto y montos fuera del tope", () => {
    assert.equal(validateFareAdjustment(1.5), null);
    assert.equal(validateFareAdjustment("mil"), null);
    assert.equal(validateFareAdjustment(500_000), null);
  });
});

describe("fareBreakdown: tabla más ajuste de la zona", () => {
  it("un ajuste positivo sube el total", () => {
    assert.deepEqual(fareBreakdown(6.2, TABLA, PANCE), { km: 6.2, table: 10_000, adjustment: 2_000, zone: { id: 1, name: "Pance" }, total: 12_000 });
  });

  it("un ajuste negativo lo baja", () => {
    assert.equal(fareBreakdown(4, TABLA, CENTRO)?.total, 6_000);
  });

  it("el total nunca baja de 0", () => {
    const regalo = { ...CENTRO, fareAdjustment: -50_000 };
    assert.deepEqual(fareBreakdown(1, TABLA, regalo), { km: 1, table: 5_000, adjustment: -50_000, zone: { id: 2, name: "Centro" }, total: 0 });
  });

  it("sin zona no hay ajuste", () => {
    assert.equal(fareBreakdown(4.1, TABLA, null)?.total, 8_000);
    assert.equal(fareBreakdown(4.1, TABLA, null)?.adjustment, 0);
  });

  it("con la tabla vacía no hay precio, aunque haya ajuste", () => {
    assert.equal(fareBreakdown(3, [], PANCE), null);
  });
});

describe("adjustmentZoneAt: el ajuste es de la zona de la entrega", () => {
  it("dentro de una zona, la suya", () => {
    assert.equal(adjustmentZoneAt({ lat: 3.32, lng: -76.58 }, ZONES)?.name, "Pance");
  });

  it("dentro de dos que se cruzan, la más pequeña", () => {
    const sur = { id: 3, name: "Sur grande", ring: square(3.25, -76.65, 0.2), fareAdjustment: 500 };
    assert.equal(adjustmentZoneAt({ lat: 3.32, lng: -76.58 }, [sur, PANCE])?.name, "Pance");
  });

  it("cerca del borde, la zona más cercana; lejos o sin zonas, ninguna", () => {
    assert.equal(adjustmentZoneAt({ lat: 3.3 - 0.001, lng: -76.58 }, ZONES)?.name, "Pance");
    assert.equal(adjustmentZoneAt({ lat: 3.6, lng: -76.58 }, ZONES), null);
    assert.equal(adjustmentZoneAt({ lat: 3.32, lng: -76.58 }, []), null);
  });
});

describe("tabla de ejemplos", () => {
  it("el centro de una zona queda dentro, también en una L", () => {
    const ele = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 0.2, lng: 2 },
      { lat: 0.2, lng: 0.2 },
      { lat: 2, lng: 0.2 },
      { lat: 2, lng: 0 },
    ];
    assert.ok(insideRing(zoneCenter(ele), ele));
    const c = zoneCenter(PANCE.ring);
    assert.ok(Math.abs(c.lat - 3.32) < 1e-9 && Math.abs(c.lng - -76.58) < 1e-9);
  });

  it("un restaurante es de la zona más pequeña que lo contiene", () => {
    const sur = { id: 3, name: "Sur grande", ring: square(3.25, -76.65, 0.2), fareAdjustment: 0 };
    assert.equal(zoneOfPoint({ lat: 3.32, lng: -76.58 }, [sur, PANCE])?.id, PANCE.id);
    assert.equal(zoneOfPoint({ lat: 3.7, lng: -76.58 }, [sur, PANCE]), null);
  });

  it("los km típicos son la mediana", () => {
    assert.equal(medianKm([3.1, 4.6, 3.9]), 3.9);
    assert.equal(medianKm([3, 4]), 3.5);
  });
});
