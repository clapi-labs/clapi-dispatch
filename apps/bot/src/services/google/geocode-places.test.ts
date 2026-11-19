import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addressForMap, buildGeocodeQuery, placeNameVariants, resolveGeocode, type GoogleGeocodeResponse } from "./geocode";

/**
 * Conjuntos y lugares con nombre (#86). Las respuestas de Google de abajo
 * reproducen lo que se vio en staging con Reserva Campestre: la dirección que
 * da Google (Cra. 122 #5-18, Pance, ROOFTOP) es la misma, pero con la torre y
 * el apartamento, o con «unidad de», la marca como parcial. Los puntos son
 * aproximados, de prueba: lo que se mide aquí es la decisión del bot, no el
 * mapa. La medición contra Google de verdad es `npm run bot:direcciones:medir`.
 */

type Request = Parameters<typeof resolveGeocode>[1];

const RESERVA = { lat: 3.3338, lng: -76.5472 };

/** Lo que devuelve Google por Reserva Campestre; `partial` como lo marca con la torre o con «de». */
const reserva = (partial: boolean): GoogleGeocodeResponse => ({
  status: "OK",
  results: [
    {
      partial_match: partial ? true : undefined,
      types: ["premise"],
      formatted_address: "Cra. 122 #5-18, Pance, Cali, Valle del Cauca, Colombia",
      geometry: { location: RESERVA, location_type: "ROOFTOP" },
      address_components: [
        { long_name: "5-18", types: ["street_number"] },
        { long_name: "Carrera 122", types: ["route"] },
        { long_name: "Pance", types: ["neighborhood"] },
        { long_name: "Cali", types: ["locality"] },
      ],
    },
  ],
});

const NOTHING: GoogleGeocodeResponse = { status: "ZERO_RESULTS", results: [] };

/** Un «Google» que contesta según lo que se le pregunta; guarda cada consulta. */
function fakeGoogle(answers: (address: string) => GoogleGeocodeResponse | "failed" | "disabled") {
  const asked: string[] = [];
  const request: Request = async (address) => {
    asked.push(address);
    const answer = answers(address);
    return typeof answer === "string" ? { kind: answer } : { kind: "response", data: answer };
  };
  return { request, asked };
}

describe("addressForMap: al mapa no va la puerta", () => {
  it("quita la torre y el apartamento, también si van primero", () => {
    assert.equal(addressForMap("Unidad Reserva campestre, Torre 4 apto 803"), "Unidad Reserva campestre");
    assert.equal(addressForMap("Torre 4 apto 803, Unidad Reserva campestre"), "Unidad Reserva campestre");
    assert.equal(addressForMap("Local 3, Cra 50 # 10-20"), "Cra 50 # 10-20");
  });

  it("deja el nombre del edificio y lo que no es una puerta", () => {
    assert.equal(addressForMap("Calle 5 # 66-20, Edificio Torre Alta apto 1203, El Refugio"), "Calle 5 # 66-20, Edificio Torre Alta, El Refugio");
    assert.equal(addressForMap("Valle del Lili"), "Valle del Lili");
    assert.equal(addressForMap("Cra 98 # 42-105"), "Cra 98 # 42-105");
  });

  it("la consulta a Google sale con Cali y sin la puerta", () => {
    assert.equal(buildGeocodeQuery(addressForMap("Unidad Reserva campestre, Torre 4 apto 803")), "Unidad Reserva campestre, Cali, Valle del Cauca");
  });
});

describe("placeNameVariants: otras formas de nombrar el mismo conjunto", () => {
  it("quita «de» y, después, la palabra «unidad»", () => {
    assert.deepEqual(placeNameVariants("unidad de reserva campestre"), ["unidad reserva campestre", "reserva campestre"]);
    assert.deepEqual(placeNameVariants("Unidad de Reserva Campestre"), ["Unidad Reserva Campestre", "Reserva Campestre"]);
  });

  it("sin conector, solo sin la palabra que lo anuncia", () => {
    assert.deepEqual(placeNameVariants("Unidad Reserva campestre"), ["Reserva campestre"]);
    assert.deepEqual(placeNameVariants("Conjunto Reserva Campestre"), ["Reserva Campestre"]);
  });

  it("conjunto residencial, urbanización, condominio, agrupación y artículos", () => {
    assert.deepEqual(placeNameVariants("Conjunto residencial Reserva Campestre"), ["Conjunto Reserva Campestre", "Reserva Campestre"]);
    assert.deepEqual(placeNameVariants("la urbanización de los Almendros"), ["urbanización los Almendros", "los Almendros"]);
    assert.deepEqual(placeNameVariants("unidad del Sol"), ["unidad el Sol", "el Sol"]);
    assert.deepEqual(placeNameVariants("el condominio campestre de Pance, Cali"), ["condominio campestre de Pance, Cali", "campestre de Pance, Cali"]);
  });

  it("conserva el municipio del final", () => {
    assert.deepEqual(placeNameVariants("Conjunto Alfaguara, Jamundí"), ["Alfaguara, Jamundí"]);
  });

  it("separa con coma un sector conocido al final cuando la puerta salió del medio", () => {
    assert.deepEqual(placeNameVariants("reserva campestre pance"), ["reserva campestre, pance"]);
  });

  it("no inventa variantes: una calle con número, un nombre sin esas palabras o un nombre vacío", () => {
    assert.deepEqual(placeNameVariants("Cra 97 # 45-11"), []);
    assert.deepEqual(placeNameVariants("Conjunto Los Almendros, Cl. 15 Nte. #8"), []);
    assert.deepEqual(placeNameVariants("Valle del Lili"), []);
    assert.deepEqual(placeNameVariants("Bochalema"), []);
    assert.deepEqual(placeNameVariants("Unicentro Cali"), []);
    assert.deepEqual(placeNameVariants("conjunto"), []);
    assert.deepEqual(placeNameVariants("unidad de "), []);
  });
});

describe("resolveGeocode: el caso de staging", () => {
  it("«Unidad Reserva campestre, Torre 4 apto 803»: a Google solo va el conjunto, y se ubica sin escalar", async () => {
    // Como en staging: si la consulta lleva la torre, Google lo marca parcial.
    const google = fakeGoogle((address) => reserva(/torre|apto/i.test(address)));
    const { outcome, attempts, via } = await resolveGeocode("Unidad Reserva campestre, Torre 4 apto 803", google.request);
    assert.deepEqual(google.asked, ["Unidad Reserva campestre"]);
    assert.deepEqual(outcome, { kind: "found", location: RESERVA, neighborhood: "Pance" });
    assert.equal(attempts.length, 1);
    assert.equal(via, null);
  });

  it("con la puerta primero o con otras puertas, igual", async () => {
    for (const written of ["Torre 4 Apto 803, Unidad Reserva campestre", "Unidad Reserva campestre bloque C apto 202", "Unidad Reserva campestre, casa 14"]) {
      const google = fakeGoogle((address) => reserva(/torre|apto|bloque|casa/i.test(address)));
      const { outcome } = await resolveGeocode(written, google.request);
      assert.equal(outcome.kind, "found", written);
      assert.deepEqual(google.asked, ["Unidad Reserva campestre"], written);
    }
  });

  it("«unidad de reserva campestre»: con «de» Google lo marcaba parcial; se vuelve a buscar sin el conector", async () => {
    const google = fakeGoogle((address) => reserva(/\bde\b/i.test(address)));
    const { outcome, via, attempts } = await resolveGeocode("unidad de reserva campestre", google.request);
    assert.deepEqual(google.asked, ["unidad de reserva campestre", "unidad reserva campestre"]);
    assert.equal(outcome.kind, "found");
    assert.equal(via, "unidad reserva campestre");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].outcome.kind, "not_found");
  });

  it("si tampoco con «unidad», se prueba solo el nombre", async () => {
    const google = fakeGoogle((address) => reserva(/unidad/i.test(address)));
    const { outcome, via } = await resolveGeocode("unidad de reserva campestre", google.request);
    assert.deepEqual(google.asked, ["unidad de reserva campestre", "unidad reserva campestre", "reserva campestre"]);
    assert.equal(outcome.kind, "found");
    assert.equal(via, "reserva campestre");
  });

  it("si la primera forma ya se ubica, no se hace otra consulta", async () => {
    const google = fakeGoogle(() => reserva(false));
    const { outcome } = await resolveGeocode("Unidad Reserva campestre", google.request);
    assert.equal(outcome.kind, "found");
    assert.equal(google.asked.length, 1);
  });

  it("la torre y el apto quedaron en detalleDireccion, no se pierden: lo que va al mapa es solo el conjunto", async () => {
    const google = fakeGoogle(() => reserva(false));
    await resolveGeocode("Conjunto Reserva Campestre torre 1 apto 305", google.request);
    assert.deepEqual(google.asked, ["Conjunto Reserva Campestre"]);
  });
});

describe("resolveGeocode: lo que debe seguir pasando a la central", () => {
  /** Un resultado parcial de Google adivinando, sin vía ni placa escritas. */
  const guess = (formatted: string, lat: number, lng: number): GoogleGeocodeResponse => ({
    status: "OK",
    results: [
      {
        partial_match: true,
        types: ["establishment", "point_of_interest"],
        formatted_address: formatted,
        geometry: { location: { lat, lng }, location_type: "ROOFTOP" },
        address_components: [
          { long_name: "Carrera 98", types: ["route"] },
          { long_name: "Cali", types: ["locality"] },
        ],
      },
    ],
  });

  const traps: [string, string][] = [
    ["Valle del Lili", "Av. Simón Bolívar, first floor, Cra. 98 #18-49, Comuna 17, Cali, Valle del Cauca, Colombia"],
    ["Bochalema", "Cl. 48 #106-83, Bochalema, Cali, Valle del Cauca, Colombia"],
    ["Universidad del Valle sede Meléndez", "Cl. 5 #36-08, San Fernando, Cali, Valle del Cauca, Colombia"],
    ["Conjunto Bochalema", "Cl. 48 #106-83, Bochalema, Cali, Valle del Cauca, Colombia"],
    ["Unidad Valle del Lili", "Av. Simón Bolívar, first floor, Cra. 98 #18-49, Comuna 17, Cali, Valle del Cauca, Colombia"],
    ["Unidad de Univalle sede Meléndez", "Cl. 5 #36-08, San Fernando, Cali, Valle del Cauca, Colombia"],
    ["Torre 4 apto 803, Bochalema", "Cl. 48 #106-83, Bochalema, Cali, Valle del Cauca, Colombia"],
  ];

  for (const [written, formatted] of traps) {
    it(`«${written}»: Google adivina un punto parcial, también sin la palabra «conjunto» o «unidad»: sigue sin ubicarse`, async () => {
      const google = fakeGoogle(() => guess(formatted, 3.3727, -76.5256));
      const { outcome } = await resolveGeocode(written, google.request);
      assert.deepEqual(outcome, { kind: "not_found" });
    });
  }

  it("un nombre sin «unidad» ni «conjunto» no se reintenta: una sola consulta", async () => {
    for (const written of ["Valle del Lili", "Bochalema", "Universidad del Valle sede Meléndez"]) {
      const google = fakeGoogle(() => guess("Cl. 48 #106-83, Cali", 3.36, -76.516));
      await resolveGeocode(written, google.request);
      assert.equal(google.asked.length, 1, written);
    }
  });

  it("la puerta sola o el barrio solo no es una dirección", async () => {
    const google = fakeGoogle(() => NOTHING);
    for (const written of ["Torre 4 apto 803", "casa 14"]) {
      const { outcome } = await resolveGeocode(written, google.request);
      assert.deepEqual(outcome, { kind: "not_found" });
    }
  });

  it("sin la vía ni la placa del resultado, un parcial sigue sin valer aunque el nombre pedido «se parezca»", async () => {
    const google = fakeGoogle(() => reserva(true));
    const { outcome } = await resolveGeocode("unidad de reserva campestre", google.request);
    // Todas las formas devuelven parcial: no se acepta ninguna.
    assert.deepEqual(outcome, { kind: "not_found" });
    assert.equal(google.asked.length, 3);
  });

  it("una calle con número no se reescribe: una sola consulta", async () => {
    const google = fakeGoogle(() => NOTHING);
    await resolveGeocode("Cra 97 # 45-11 local 102", google.request);
    assert.deepEqual(google.asked, ["Cra 97 # 45-11"]);
  });

  it("un texto genérico sin nombre («Conjunto residencial») no consulta a Google y pasa a la central", async () => {
    const google = fakeGoogle(() => reserva(false));
    const { outcome } = await resolveGeocode("Conjunto residencial", google.request);
    assert.deepEqual(outcome, { kind: "not_found" });
    assert.equal(google.asked.length, 0);
  });

  it("otro municipio: una variante que Google ubica en Cali no vale cuando la dirección era de Jamundí", async () => {
    const google = fakeGoogle((address) => (/alfaguara/i.test(address) && !/conjunto/i.test(address) ? reserva(false) : NOTHING));
    const { outcome, asked } = { ...(await resolveGeocode("Conjunto Alfaguara Torre 2 apto 301, Jamundí", google.request)), asked: google.asked };
    assert.deepEqual(asked, ["Conjunto Alfaguara, Jamundí", "Alfaguara, Jamundí"]);
    assert.deepEqual(outcome, { kind: "not_found" });
  });
});

describe("resolveGeocode: cuando Google no responde", () => {
  it("la primera consulta falla: es un fallo, no se intenta nada más", async () => {
    const google = fakeGoogle(() => "failed");
    const { outcome } = await resolveGeocode("unidad de reserva campestre", google.request);
    assert.deepEqual(outcome, { kind: "failed" });
    assert.equal(google.asked.length, 1);
  });

  it("sin llave de Google", async () => {
    const google = fakeGoogle(() => "disabled");
    const { outcome } = await resolveGeocode("Unidad Reserva campestre", google.request);
    assert.deepEqual(outcome, { kind: "disabled" });
  });

  it("una variante que falla no cambia lo que ya se sabía: no estaba", async () => {
    const google = fakeGoogle((address) => (address === "unidad de reserva campestre" ? reserva(true) : "failed"));
    const { outcome } = await resolveGeocode("unidad de reserva campestre", google.request);
    assert.deepEqual(outcome, { kind: "not_found" });
  });

  it("un estado de Google distinto de OK es un fallo", async () => {
    const google = fakeGoogle(() => ({ status: "OVER_QUERY_LIMIT", results: [] }));
    const { outcome } = await resolveGeocode("unidad de reserva campestre", google.request);
    assert.deepEqual(outcome, { kind: "failed" });
    assert.equal(google.asked.length, 1);
  });
});
