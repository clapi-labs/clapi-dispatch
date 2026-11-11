import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { distanceToRingM, insideRing, NEAR_ZONE_M, ringAreaM2, serviceVerdictAt, type ServiceZoneShape } from "./service-zones";

/** Un cuadrado de `side` grados con la esquina suroeste en (lat, lng). */
const square = (lat: number, lng: number, side: number) => [
  { lat, lng },
  { lat, lng: lng + side },
  { lat: lat + side, lng: lng + side },
  { lat: lat + side, lng },
];

/** Grados de latitud que son `m` metros (al norte o al sur). */
const metersLat = (m: number) => m / 111_195;

// Ciudad Jardín: 0,02° de lado (unos 2,2 km). El Ingenio la toca por el norte
// y se cruza un poco con ella.
const CIUDAD_JARDIN: ServiceZoneShape = { id: 1, name: "Ciudad Jardín", ring: square(3.36, -76.54, 0.02) };
const EL_INGENIO: ServiceZoneShape = { id: 2, name: "El Ingenio", ring: square(3.378, -76.53, 0.01) };
const ZONES = [CIUDAD_JARDIN, EL_INGENIO];

describe("insideRing", () => {
  it("distingue dentro y fuera, también en un contorno cóncavo", () => {
    assert.equal(insideRing({ lat: 3.37, lng: -76.53 }, CIUDAD_JARDIN.ring), true);
    assert.equal(insideRing({ lat: 3.45, lng: -76.53 }, CIUDAD_JARDIN.ring), false);
    // Una L: el hueco de la L está fuera.
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
  it("mide en metros sin importar el sentido del contorno", () => {
    const area = ringAreaM2(square(3.4, -76.5, 0.01));
    // 0,01° ≈ 1.112 m de norte a sur y ≈ 1.110 m de este a oeste en Cali.
    assert.ok(Math.abs(area - 1_234_000) < 15_000, `área ${area}`);
    assert.ok(Math.abs(ringAreaM2([...square(3.4, -76.5, 0.01)].reverse()) - area) < 50);
  });
});

describe("distanceToRingM", () => {
  it("mide hasta el tramo más cercano, no hasta la esquina más cercana", () => {
    // 150 m al sur del borde sur, frente a la mitad del tramo.
    const d = distanceToRingM({ lat: 3.36 - metersLat(150), lng: -76.53 }, CIUDAD_JARDIN.ring);
    assert.ok(Math.abs(d - 150) < 2, `distancia ${d}`);
  });

  it("dentro del contorno es la distancia al borde", () => {
    const d = distanceToRingM({ lat: 3.36 + metersLat(40), lng: -76.53 }, CIUDAD_JARDIN.ring);
    assert.ok(Math.abs(d - 40) < 2, `distancia ${d}`);
  });
});

describe("serviceVerdictAt", () => {
  it("sin zonas marcadas no restringe nada", () => {
    assert.deepEqual(serviceVerdictAt({ lat: 3.45, lng: -76.53 }, []), { kind: "sin_zonas" });
    // Una zona sin contorno usable cuenta como si no hubiera.
    assert.deepEqual(serviceVerdictAt({ lat: 3.45, lng: -76.53 }, [{ id: 9, name: "Rota", ring: [] }]), { kind: "sin_zonas" });
  });

  it("dentro de una zona: se hace el pedido", () => {
    const v = serviceVerdictAt({ lat: 3.365, lng: -76.535 }, ZONES);
    assert.equal(v.kind, "dentro");
    assert.deepEqual(v.kind === "dentro" && v.zones.map((z) => z.name), ["Ciudad Jardín"]);
  });

  it("donde dos zonas se cruzan está cubierto, y la más pequeña va primero", () => {
    const v = serviceVerdictAt({ lat: 3.379, lng: -76.525 }, ZONES);
    assert.equal(v.kind, "dentro");
    assert.deepEqual(v.kind === "dentro" && v.zones.map((z) => z.name), ["El Ingenio", "Ciudad Jardín"]);
  });

  it("fuera pero a menos de 300 m del borde: cerca, con la zona y la distancia", () => {
    const v = serviceVerdictAt({ lat: 3.36 - metersLat(200), lng: -76.53 }, ZONES);
    assert.equal(v.kind, "cerca");
    if (v.kind !== "cerca") return;
    assert.equal(v.zone.name, "Ciudad Jardín");
    assert.ok(Math.abs(v.distanceM - 200) < 3, `distancia ${v.distanceM}`);
  });

  it("fuera y lejos de toda zona: no hay servicio, y dice cuál es la más cercana", () => {
    const v = serviceVerdictAt({ lat: 3.45, lng: -76.53 }, ZONES);
    assert.equal(v.kind, "fuera");
    if (v.kind !== "fuera") return;
    assert.equal(v.zone.name, "El Ingenio");
    assert.ok(v.distanceM > 6_000);
  });

  it("el límite de 300 m: 290 m es cerca, 310 m es lejos", () => {
    assert.equal(NEAR_ZONE_M, 300);
    assert.equal(serviceVerdictAt({ lat: 3.36 - metersLat(290), lng: -76.53 }, ZONES).kind, "cerca");
    assert.equal(serviceVerdictAt({ lat: 3.36 - metersLat(310), lng: -76.53 }, ZONES).kind, "fuera");
  });

  it("en el hueco de una zona cóncava, cerca del borde, es cerca y no dentro", () => {
    // Una U de 1 km: el hueco del medio (200 m de ancho) no es zona.
    const u: ServiceZoneShape = {
      id: 3,
      name: "La U",
      ring: [
        { lat: 3.4, lng: -76.5 },
        { lat: 3.4, lng: -76.491 },
        { lat: 3.409, lng: -76.491 },
        { lat: 3.409, lng: -76.4946 },
        { lat: 3.402, lng: -76.4946 },
        { lat: 3.402, lng: -76.4964 },
        { lat: 3.409, lng: -76.4964 },
        { lat: 3.409, lng: -76.5 },
      ],
    };
    const v = serviceVerdictAt({ lat: 3.406, lng: -76.4955 }, [u]);
    assert.equal(v.kind, "cerca");
    assert.ok(v.kind === "cerca" && v.distanceM < 120);
  });

  it("no depende del orden de las zonas", () => {
    const punto = { lat: 3.379, lng: -76.525 };
    assert.deepEqual(serviceVerdictAt(punto, ZONES), serviceVerdictAt(punto, [...ZONES].reverse()));
  });
});
