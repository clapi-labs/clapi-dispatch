import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coverageAt, coverageQueryReason, nearEdgeText, noServiceText } from "./coverage";

/** Ciudad Jardín de mentiras: un cuadrado de 0,02° (unos 2,2 km). */
const CIUDAD_JARDIN = {
  id: 1,
  name: "Ciudad Jardín",
  ring: [
    { lat: 3.36, lng: -76.54 },
    { lat: 3.36, lng: -76.52 },
    { lat: 3.38, lng: -76.52 },
    { lat: 3.38, lng: -76.54 },
  ],
};
/** Grados de latitud que son `m` metros. */
const metersLat = (m: number) => m / 111_195;

const ADENTRO = { lat: 3.37, lng: -76.53 };
const CERCA = { lat: 3.36 - metersLat(150), lng: -76.53 };
const LEJOS = { lat: 3.45, lng: -76.53 };

describe("coverageAt: dónde cae la entrega", () => {
  it("adentro de una zona: el pedido sigue normal", () => {
    assert.deepEqual(coverageAt(ADENTRO, [CIUDAD_JARDIN]), { kind: "ok" });
  });

  it("cerca del borde: va a la central, con la zona y los metros", () => {
    const c = coverageAt(CERCA, [CIUDAD_JARDIN]);
    assert.equal(c.kind, "cerca");
    assert.ok(c.kind === "cerca" && c.zone === "Ciudad Jardín" && Math.abs(c.meters - 150) <= 2, JSON.stringify(c));
  });

  it("lejos de toda zona: no hay servicio", () => {
    assert.deepEqual(coverageAt(LEJOS, [CIUDAD_JARDIN]), { kind: "fuera" });
  });

  it("sin zonas cargadas: todo funciona como antes", () => {
    for (const point of [ADENTRO, CERCA, LEJOS]) assert.deepEqual(coverageAt(point, []), { kind: "ok" });
  });

  it("sin punto (la ubicó la central a mano): no se puede revisar, sigue normal", () => {
    assert.deepEqual(coverageAt(null, [CIUDAD_JARDIN]), { kind: "ok" });
  });
});

describe("los textos", () => {
  it("al restaurante, sin servicio", () => {
    assert.equal(noServiceText([]), null);
    assert.equal(noServiceText(["Navarro"]), "Qué pena, pero hasta Navarro no manejamos domicilio 🙏");
    assert.equal(noServiceText(["Navarro", "La Buitrera", "Montebello"]), "Qué pena, pero hasta Navarro, La Buitrera y Montebello no manejamos domicilio 🙏");
  });

  it("al restaurante, mientras decide la central", () => {
    assert.equal(nearEdgeText(["Bochalema"]), "Déjame confirmar con la central si llegamos hasta Bochalema 🙏 Te aviso en un momento.");
  });

  it("a la central, con la dirección, la zona y los metros", () => {
    assert.equal(
      coverageQueryReason([{ address: "Calle 48 # 120-30", zone: "Bochalema", meters: 180 }]),
      "Consulta de cobertura: «Calle 48 # 120-30» (a 180 m de «Bochalema») queda fuera de las zonas de servicio, cerca del borde. ¿Se hace?",
    );
  });
});
