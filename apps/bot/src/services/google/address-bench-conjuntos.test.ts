import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { insideRing, type LatLngPoint } from "@dispatch/shared";

import {
  barriosFromFile,
  caseAddress,
  distanceToSectorM,
  judgeCase,
  locatedFromGoogle,
  offlineProblems,
  plainName,
  renderReport,
  SECTOR_TOLERANCE_M,
  summarize,
  validateCases,
  type AddressCase,
} from "./address-bench";
import { resolveGeocode, type GoogleGeocodeResponse } from "./geocode";

/**
 * Los casos de conjuntos, variantes de escritura, cruces, tipeos, municipios
 * vecinos y trampas que se agregaron con el #86, y lo que la medición hace con
 * ellos sin Google. La corrida contra Google de verdad se hace desde el
 * servidor (`deploy/measure-addresses.sh`): ahí se ve el resultado completo.
 */

const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
const FILE = read("../../../direcciones/casos.json");
const CASES: AddressCase[] = FILE.casos;
const BARRIOS = barriosFromFile(read("../../../../portal/public/zonas/barrios.json"));
const byId = (id: string) => CASES.find((c) => c.id === id)!;
const ofKind = (tipo: string) => CASES.filter((c) => c.tipo === tipo);
const ctx = { barrios: BARRIOS, zones: null };

/** Un punto dentro del barrio: el promedio de su borde, o un vértice si el barrio es cóncavo y el promedio queda afuera. */
function centroidOf(ring: LatLngPoint[]): LatLngPoint {
  const mean = { lat: ring.reduce((n, p) => n + p.lat, 0) / ring.length, lng: ring.reduce((n, p) => n + p.lng, 0) / ring.length };
  return insideRing(mean, ring) ? mean : ring[0];
}

describe("el benchmark ampliado de Cali", () => {
  it("son más de 150 casos y siguen bien armados", () => {
    assert.deepEqual(validateCases(FILE), []);
    assert.ok(CASES.length >= 150, `${CASES.length} casos`);
  });

  it("al menos 45 casos nuevos del #86: conjuntos, variantes de escritura, cruces, tipeos, municipios vecinos y trampas", () => {
    const added = CASES.filter((c) => /^(conjunto|via|cruce|tipeo|vecino)-/.test(c.id) || /^trampa-(2\d)$/.test(c.id));
    assert.ok(added.length >= 45, `${added.length} casos nuevos`);
    for (const kind of ["conjunto", "variante", "esquina", "tipeo", "municipio", "trampa"]) assert.ok(ofKind(kind).length >= 4, kind);
  });

  it("Reserva Campestre: la unidad, «unidad de…», con torre, apto, bloque y la puerta dicha primero", () => {
    const rc = CASES.filter((c) => /reserva campestre/i.test(c.texto));
    assert.ok(rc.length >= 8, `${rc.length} casos`);
    const texts = rc.map((c) => c.texto.toLowerCase());
    assert.ok(texts.some((t) => t.includes("unidad de reserva campestre")), "«unidad de…»");
    assert.ok(texts.some((t) => /torre 4 apto 803/.test(t)), "torre 4 apto 803");
    assert.ok(texts.some((t) => /^torre 4 apto 803,/.test(t)), "la puerta primero");
    assert.ok(texts.some((t) => /bloque c apto 202/.test(t)), "bloque");
    for (const c of rc) {
      assert.equal(c.exigido, true, c.id);
      assert.equal(c.esperado, "ubicar", c.id);
    }
  });

  it("la puerta sale del texto: ningún caso manda la torre, el apto, la casa o el local al mapa", () => {
    const problems = CASES.flatMap((c) => offlineProblems(c).map((p) => `${c.id}: ${p}`));
    assert.deepEqual(problems, []);
    assert.deepEqual(
      CASES.filter((c) => /\b(torre|apto|bloque|casa|local)\b\.?\s*\d/i.test(caseAddress(c))).map((c) => c.id),
      [],
    );
  });

  it("las direcciones válidas y los conjuntos conocidos son exigidos; las trampas, ninguna", () => {
    const required = CASES.filter((c) => c.exigido);
    assert.ok(required.length >= 30, `${required.length} exigidos`);
    for (const c of required) assert.ok(c.referencia || c.sector?.length, `${c.id}: sin punto verificado ni sector`);
    assert.equal(CASES.filter((c) => c.tipo === "trampa" && c.exigido).length, 0);
    assert.ok(CASES.filter((c) => c.esperado === "escalar").length >= 15, "trampas que deben escalar");
  });

  it("los sectores son barrios que existen en el archivo de la IDESC", () => {
    const names = new Set(BARRIOS.map((b) => plainName(b.nombre)));
    const unknown = CASES.flatMap((c) => (c.sector ?? []).filter((n) => !names.has(plainName(n))).map((n) => `${c.id}: ${n}`));
    assert.deepEqual(unknown, []);
  });

  it("las variantes de una dirección verificada usan el mismo punto que la original", () => {
    for (const [variant, base] of [
      ["via-01", "estandar-04"],
      ["via-05", "estandar-09"],
      ["tipeo-01", "estandar-13"],
      ["cruce-01", "esquina-01"],
    ] as const) {
      assert.equal(byId(variant).referencia!.lat, byId(base).referencia!.lat, variant);
      assert.equal(byId(variant).referencia!.lng, byId(base).referencia!.lng, variant);
    }
  });

  it("cubre los municipios vecinos sin pegarles «Cali»", () => {
    const towns = new Set(ofKind("municipio").map((c) => c.municipio));
    for (const t of ["jamundi", "yumbo", "candelaria"]) assert.ok(towns.has(t as never), t);
  });
});

describe("el juicio con sector, en vez de punto verificado", () => {
  const pance = BARRIOS.find((b) => plainName(b.nombre) === "parcelaciones pance")!;
  const inPance = centroidOf(pance.ring);
  const north = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + m / 111_195, lng: p.lng });
  const rc = byId("conjunto-01");

  it("dentro del sector: ubicada", () => {
    assert.equal(distanceToSectorM(inPance, rc.sector!, BARRIOS), 0);
    assert.equal(judgeCase(rc, { outcome: { kind: "found", location: inPance } }, ctx).verdict, "en_sector");
  });

  it("a un paso del borde todavía vale; más allá es otro sector", () => {
    const edge = [...pance.ring].sort((a, b) => b.lat - a.lat)[0];
    assert.equal(judgeCase(rc, { outcome: { kind: "found", location: north(edge, SECTOR_TOLERANCE_M - 200) } }, ctx).verdict, "en_sector");
    assert.equal(judgeCase(rc, { outcome: { kind: "found", location: { lat: 3.45, lng: -76.53 } } }, ctx).verdict, "lejos");
  });

  it("pasar a la central teniendo punto es fallar un exigido", () => {
    const result = judgeCase(rc, { outcome: { kind: "not_found" } }, ctx);
    assert.equal(result.verdict, "escalo");
    assert.equal(result.required, true);
    assert.deepEqual(summarize([result]).requiredMisses.map((r) => r.id), ["conjunto-01"]);
  });

  it("ubicado en el sector no falla; lejos sí es grave", () => {
    const ok = judgeCase(rc, { outcome: { kind: "found", location: inPance } }, ctx);
    assert.equal(summarize([ok]).requiredMisses.length, 0);
    const far = judgeCase(rc, { outcome: { kind: "found", location: { lat: 3.45, lng: -76.53 } } }, ctx);
    assert.equal(summarize([far]).serious.length, 1);
  });

  it("un exigido con punto verificado exige exacto o aceptable", () => {
    const c = byId("via-01");
    const ref = c.referencia!;
    assert.equal(summarize([judgeCase(c, { outcome: { kind: "found", location: north(ref, 10) } }, ctx)]).requiredMisses.length, 0);
    assert.equal(summarize([judgeCase(c, { outcome: { kind: "found", location: north(ref, 300) } }, ctx)]).requiredMisses.length, 1);
  });

  it("el informe cuenta los exigidos y los que fallan", () => {
    const results = [
      judgeCase(rc, { outcome: { kind: "found", location: inPance } }, ctx),
      judgeCase(byId("conjunto-02"), { outcome: { kind: "not_found" } }, ctx),
    ];
    const report = renderReport(results, { fecha: "2026-11-18", servidor: "prueba", extraccion: false, zonas: null });
    assert.match(report, /Exigidos .*: 1 de 2\. Fallan: \*\*1\*\*/);
    assert.match(report, /\*\*conjunto-02\*\*/);
    assert.match(report, /Dentro del sector esperado/);
  });

  it("un caso exigido sin punto ni sector no es válido", () => {
    const bad = { ...FILE, casos: [{ ...rc, id: "x", sector: undefined }] };
    assert.match(validateCases(bad).join("\n"), /exigido sin punto verificado necesita un «sector»/);
  });
});

describe("todos los casos de Reserva Campestre, con un Google que reproduce lo de staging", () => {
  const pance = BARRIOS.find((b) => plainName(b.nombre) === "parcelaciones pance")!;
  const spot = centroidOf(pance.ring);

  /** Con la torre, el apto, el bloque o «de» en la consulta, Google marcaba parcial el mismo punto. */
  const google = (partialWhen: RegExp) => async (address: string) => {
    const data: GoogleGeocodeResponse = {
      status: "OK",
      results: [
        {
          partial_match: partialWhen.test(address) ? true : undefined,
          types: ["premise"],
          formatted_address: "Cra. 122 #5-18, Pance, Cali, Valle del Cauca, Colombia",
          geometry: { location: spot, location_type: "ROOFTOP" },
          address_components: [
            { long_name: "5-18", types: ["street_number"] },
            { long_name: "Carrera 122", types: ["route"] },
            { long_name: "Cali", types: ["locality"] },
          ],
        },
      ],
    };
    return { kind: "response" as const, data };
  };

  for (const c of CASES.filter((x) => /reserva campestre/i.test(x.texto))) {
    it(`${c.id} «${c.texto}» se ubica en Pance sin escalar`, async () => {
      const { outcome, attempts, via } = await resolveGeocode(caseAddress(c), google(/torre|apto|bloque|casa|\bde\b/i));
      const last = attempts[attempts.length - 1];
      const result = judgeCase(c, locatedFromGoogle(last.data, last.address, null, via), ctx);
      assert.equal(outcome.kind, "found");
      assert.equal(result.verdict, "en_sector");
      assert.equal(summarize([result]).requiredMisses.length, 0);
    });
  }

  it("y las trampas siguen sin ubicarse con ese mismo Google", async () => {
    // Un Google que adivina cualquier cosa con el mismo punto, parcial: las trampas no lo aceptan.
    for (const c of CASES.filter((x) => x.tipo === "trampa" && x.esperado === "escalar" && x.municipio === "cali")) {
      const { outcome } = await resolveGeocode(caseAddress(c), google(/.*/));
      assert.equal(outcome.kind, "not_found", c.id);
    }
  });
});
