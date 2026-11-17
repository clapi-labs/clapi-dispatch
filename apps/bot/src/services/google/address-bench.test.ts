import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { distanceToRingM } from "@dispatch/shared";

import {
  ACCEPTABLE_M,
  EXACT_M,
  barriosFromFile,
  caliBarrioAt,
  judgeCase,
  locatedFromGoogle,
  offlineProblems,
  renderReport,
  summarize,
  validateCases,
  type AddressCase,
  type Located,
} from "./address-bench";

/**
 * La medición de precisión sin red (docs/DIRECCIONES-Y-ZONAS.md, «Precisión
 * de las direcciones»): los casos están bien armados, lo que se decide antes
 * de llamar a Google sale bien para cada uno, y el juicio de cada resultado
 * es el que se espera. La corrida contra Google se hace desde el servidor.
 */

const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
const FILE = read("../../../direcciones/casos.json");
const CASES: AddressCase[] = FILE.casos;
const BARRIOS = barriosFromFile(read("../../../../portal/public/zonas/barrios.json"));
const byId = (id: string) => CASES.find((c) => c.id === id)!;

describe("los casos", () => {
  it("están bien armados", () => {
    assert.deepEqual(validateCases(FILE), []);
  });

  it("cubren direcciones estándar, como llegan por WhatsApp, lugares, barrios solos y trampas de municipio", () => {
    const kinds = new Set(CASES.map((c) => c.tipo));
    for (const k of ["estandar", "coloquial", "esquina", "lugar", "solo-barrio", "incompleta", "trampa"]) assert.ok(kinds.has(k), k);
    const towns = new Set(CASES.map((c) => c.municipio));
    for (const t of ["cali", "jamundi", "yumbo", "candelaria", "palmira"]) assert.ok(towns.has(t as never), t);
    assert.ok(CASES.filter((c) => c.referencia).length >= 50, "al menos 50 con punto verificado");
  });

  it("cada punto verificado de Cali cae en un barrio de Cali o a menos de 1 km de uno (bordes de la IDESC)", () => {
    // El zoológico, por ejemplo, queda en la reserva del río, al lado de los barrios.
    const far = CASES.filter((c) => c.referencia && c.municipio === "cali" && !caliBarrioAt(c.referencia, BARRIOS))
      .filter((c) => Math.min(...BARRIOS.map((b) => distanceToRingM(c.referencia!, b.ring))) > 1000)
      .map((c) => c.id);
    assert.deepEqual(far, []);
  });

  it("los de Jamundí y Yumbo verificados quedan fuera de los barrios de Cali", () => {
    const inCali = CASES.filter((c) => c.referencia && c.municipio !== "cali" && caliBarrioAt(c.referencia, BARRIOS)).map((c) => c.id);
    assert.deepEqual(inCali, []);
  });

  it("sin Google: busca en el municipio que es, confirma las que no dicen el tipo de vía y no manda la puerta al mapa", () => {
    const problems = CASES.flatMap((c) => offlineProblems(c).map((p) => `${c.id} «${c.texto}»: ${p}`));
    assert.deepEqual(problems, []);
  });
});

const JAMUNDI_EN_CALI = {
  status: "OK",
  results: [
    {
      formatted_address: "Cl. 30 #1-15, Ciudad Pacífica, Cali, Valle del Cauca, Colombia",
      geometry: { location: { lat: 3.3433, lng: -76.5215 }, location_type: "RANGE_INTERPOLATED" },
      address_components: [
        { long_name: "1-15", types: ["street_number"] },
        { long_name: "Calle 30", types: ["route"] },
        { long_name: "Ciudad Pacífica", types: ["neighborhood"] },
        { long_name: "Cali", types: ["locality"] },
      ],
    },
  ],
};

const found = (lat: number, lng: number): Located => ({ outcome: { kind: "found", location: { lat, lng } } });
/** `m` metros al norte del punto. */
const north = (p: { lat: number; lng: number }, m: number) => found(p.lat + m / 111_195, p.lng);
const ctx = { barrios: BARRIOS, zones: null };

describe("el juicio de cada caso", () => {
  const standard = byId("estandar-01");
  const ref = standard.referencia!;

  it("por la distancia al punto verificado: exacto, aceptable, fallo y lejos", () => {
    assert.equal(judgeCase(standard, north(ref, EXACT_M - 5), ctx).verdict, "exacto");
    assert.equal(judgeCase(standard, north(ref, ACCEPTABLE_M - 5), ctx).verdict, "aceptable");
    assert.equal(judgeCase(standard, north(ref, 300), ctx).verdict, "fallo");
    assert.equal(judgeCase(standard, north(ref, 900), ctx).verdict, "lejos");
    assert.equal(judgeCase(standard, north(ref, 300), ctx).meters, 300);
  });

  it("si no la ubica teniendo punto, pasó a la central de más; si Google no responde, no se midió", () => {
    assert.equal(judgeCase(standard, { outcome: { kind: "not_found" } }, ctx).verdict, "escalo");
    assert.equal(judgeCase(standard, { outcome: { kind: "failed" } }, ctx).verdict, "error");
  });

  it("solo el barrio: si da un punto, lo inventó", () => {
    const barrio = byId("trampa-13");
    assert.equal(judgeCase(barrio, found(3.3725, -76.5195), ctx).verdict, "falso_positivo");
    assert.equal(judgeCase(barrio, { outcome: { kind: "not_found" } }, ctx).verdict, "escalo_bien");
  });

  it("el caso de 6256a75, de punta a punta: Jamundí que Google pone en Ciudad Pacífica", () => {
    const jamundi = byId("trampa-01");
    // Si el filtro lo dejara pasar, la medición lo marca grave por caer dentro de un barrio de Cali.
    assert.equal(judgeCase(jamundi, found(3.3433, -76.5215), ctx).verdict, "otro_municipio");
    // Con el filtro de hoy, la misma respuesta de Google pasa a la central.
    const located = locatedFromGoogle(JAMUNDI_EN_CALI, jamundi.texto);
    assert.equal(located.outcome.kind, "not_found");
    assert.equal(located.google?.formatted, "Cl. 30 #1-15, Ciudad Pacífica, Cali, Valle del Cauca, Colombia");
    assert.equal(judgeCase(jamundi, located, ctx).verdict, "escalo_bien");
  });

  it("la cobertura: avisa si con el punto real la central decidiría y el bot lo deja pasar", () => {
    // Una zona que llega hasta 100 m al sur del punto real: el real queda cerca del borde.
    const edge = ref.lat - 100 / 111_195;
    const zone = { id: 1, name: "Prueba", ring: [{ lat: edge - 0.01, lng: -76.53 }, { lat: edge - 0.01, lng: -76.51 }, { lat: edge, lng: -76.51 }, { lat: edge, lng: -76.53 }] };
    const r = judgeCase(standard, north(ref, -150), { barrios: BARRIOS, zones: [zone] });
    assert.deepEqual(r.coverage, { sistema: "dentro", referencia: "cerca" });
    assert.match(r.coverageProblem ?? "", /cerca del borde/);
  });
});

describe("el resumen y el informe", () => {
  const results = [
    judgeCase(byId("estandar-01"), north(byId("estandar-01").referencia!, 10), ctx),
    judgeCase(byId("estandar-02"), north(byId("estandar-02").referencia!, 120), ctx),
    judgeCase(byId("estandar-03"), north(byId("estandar-03").referencia!, 700), ctx),
    judgeCase(byId("estandar-04"), { outcome: { kind: "not_found" } }, ctx),
    judgeCase(byId("estandar-05"), { outcome: { kind: "failed" } }, ctx),
    judgeCase(byId("trampa-13"), { outcome: { kind: "not_found" } }, ctx),
    judgeCase({ ...byId("lugar-01"), referencia: null }, found(3.476, -76.527), ctx),
  ];

  it("el acierto es sobre los que tenían punto verificado y Google respondió", () => {
    const s = summarize(results);
    assert.equal(s.measurable, 4);
    assert.equal(s.hits, 2);
    assert.equal(s.hitRate, 0.5);
    assert.equal(s.medianM, 120);
    assert.equal(s.maxM, 700);
    assert.deepEqual(
      s.serious.map((r) => r.id),
      ["estandar-03"],
    );
  });

  it("el informe dice el acierto, lo grave y cada caso", () => {
    const report = renderReport(results, { fecha: "2026-11-17", servidor: "prueba", extraccion: false, zonas: null });
    assert.match(report, /Acierto: 50 % \(2 de 4\)/);
    assert.match(report, /\*\*estandar-03\*\*/);
    assert.match(report, /\| lugar-01 \| Centro Comercial Chipichape \| Ubicada, falta verificar el punto \|/);
  });
});
