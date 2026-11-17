import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildGeocodeQuery, interpretGeocode, requestedMunicipality } from "./geocode";

describe("requestedMunicipality y buildGeocodeQuery", () => {
  it("para una dirección de Cali agrega «, Cali, Valle del Cauca» y separa el #", () => {
    assert.equal(requestedMunicipality("Cra 100#5-169 Ciudad Jardín"), null);
    assert.equal(buildGeocodeQuery("Cra 100#5-169 Ciudad Jardín"), "Cra 100 # 5-169 Ciudad Jardín, Cali, Valle del Cauca");
  });

  it("no agrega «, Cali» cuando la dirección es de Jamundí, Yumbo, Candelaria o Palmira", () => {
    assert.equal(requestedMunicipality("Calle 30#1-15 jamundi")?.key, "jamundi");
    assert.equal(buildGeocodeQuery("Calle 30#1-15 jamundi"), "Calle 30 # 1-15, Jamundí, Valle del Cauca");
    assert.equal(buildGeocodeQuery("Cra 10 # 5-20, Yumbo"), "Cra 10 # 5-20, Yumbo, Valle del Cauca");
    assert.equal(buildGeocodeQuery("Alfaguara, Calle 3 # 10-20"), "Alfaguara, Calle 3 # 10-20, Jamundí, Valle del Cauca");
    assert.equal(buildGeocodeQuery("Poblado Campestre, Manzana B Casa 4"), "Poblado Campestre, Manzana B Casa 4, Candelaria, Valle del Cauca");
  });

  it("no confunde «Vía Cali - Jamundí» o «Autopista Cali Yumbo» con otro municipio", () => {
    assert.equal(requestedMunicipality("Cra 122 # 18-50 Vía Cali - Jamundí, Pance"), null);
    assert.equal(buildGeocodeQuery("Cra 122 # 18-50 Vía Cali - Jamundí, Pance"), "Cra 122 # 18-50 Vía Cali - Jamundí, Pance, Cali, Valle del Cauca");
  });
});

describe("interpretGeocode: no cruza municipios ni inventa otra calle", () => {
  it("rechaza un punto en Ciudad Pacífica / Villa Fátima (Cali) cuando la dirección pedía Jamundí", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            formatted_address: "Cl. 30 #1-15, Villa Fatima, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.3433, lng: -76.5215 }, location_type: "RANGE_INTERPOLATED" },
            address_components: [
              { long_name: "1-15", types: ["street_number"] },
              { long_name: "Calle 30", types: ["route"] },
              { long_name: "Villa Fatima", types: ["neighborhood"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "Calle 30#1-15 jamundi",
    );
    assert.deepEqual(outcome, { kind: "not_found" });
  });

  it("acepta un punto real en Jamundí cuando la dirección pide Jamundí", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            formatted_address: "Cl. 10 #5-20, Jamundí, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.2615, lng: -76.5368 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "5-20", types: ["street_number"] },
              { long_name: "Calle 10", types: ["route"] },
              { long_name: "Alfaguara", types: ["neighborhood"] },
              { long_name: "Jamundí", types: ["locality"] },
            ],
          },
        ],
      },
      "Calle 10 # 5-20 Jamundí",
    );
    assert.deepEqual(outcome, {
      kind: "found",
      location: { lat: 3.2615, lng: -76.5368 },
      neighborhood: "Alfaguara, Jamundí",
    });
  });

  it("rechaza un resultado en Jamundí o Yumbo cuando el restaurante no nombró otro municipio (pedía en Cali)", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            formatted_address: "Cl. 10 #5-20, Jamundí, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.2615, lng: -76.5368 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "5-20", types: ["street_number"] },
              { long_name: "Calle 10", types: ["route"] },
              { long_name: "Jamundí", types: ["locality"] },
            ],
          },
        ],
      },
      "Calle 10 # 5-20",
    );
    assert.deepEqual(outcome, { kind: "not_found" });
  });

  it("rechaza un resultado donde Google salta a otra calle que no coincide ni en vía ni en placa", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            partial_match: true,
            formatted_address: "Cl. 40 #121-10, Ciudad Pacífica, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.3433, lng: -76.5215 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "121-10", types: ["street_number"] },
              { long_name: "Calle 40", types: ["route"] },
              { long_name: "Ciudad Pacífica", types: ["neighborhood"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "Calle 30 # 1-15, Ciudad Pacífica",
    );
    assert.deepEqual(outcome, { kind: "not_found" });
  });

  it("acepta una dirección válida de Cali incluso si la avenida tiene nombre propio pero conserva la placa", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            formatted_address: "Av. Pasoancho #80-20, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.385, lng: -76.538 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "80-20", types: ["street_number"] },
              { long_name: "Avenida Pasoancho", types: ["route"] },
              { long_name: "Capri", types: ["neighborhood"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "Calle 13 # 80-20",
    );
    assert.deepEqual(outcome, {
      kind: "found",
      location: { lat: 3.385, lng: -76.538 },
      neighborhood: "Capri",
    });
  });
});

/** Respuestas reales de Google desde staging (medición del 17 de noviembre de
 *  2026, docs/DIRECCIONES-Y-ZONAS.md, «Precisión de las direcciones»), recortadas. */
describe("interpretGeocode: lo que destapó la medición contra Google", () => {
  it("dos lugares con la misma placa, lejos uno del otro: no elige, decide la central", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            types: ["premise", "street_address"],
            formatted_address: "Cl. 52 #3-29, Comuna 5, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.46519, lng: -76.50023 }, location_type: "GEOMETRIC_CENTER" },
            address_components: [
              { long_name: "Calle 52", types: ["route"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
          {
            types: ["street_address", "subpremise"],
            formatted_address: "Cl. 52 #3-29, San Pedro Claver, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.42659, lng: -76.50247 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "3-29", types: ["street_number"] },
              { long_name: "Calle 52", types: ["route"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "Cl 52 # 3-29",
    );
    assert.deepEqual(outcome, { kind: "not_found" });
  });

  it("el centro de la calle lejos de la placa no la vuelve ambigua", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            types: ["street_address"],
            formatted_address: "Cra. 81 #45-05, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.38744, lng: -76.51823 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "45-05", types: ["street_number"] },
              { long_name: "Carrera 81", types: ["route"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
          {
            types: ["route"],
            formatted_address: "Cra. 81, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.40, lng: -76.52 }, location_type: "GEOMETRIC_CENTER" },
            address_components: [
              { long_name: "Carrera 81", types: ["route"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "Cra 81 # 45-05",
    );
    assert.equal(outcome.kind, "found");
  });

  it("sin vía ni placa, un resultado parcial es Google adivinando: «Valle del Lili» no es la clínica", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            partial_match: true,
            types: ["hospital", "establishment", "point_of_interest"],
            formatted_address: "Av. Simón Bolívar, first floor, Cra. 98 #18-49, Comuna 17, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.37274, lng: -76.52563 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "Carrera 98", types: ["route"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "Valle del Lili",
    );
    assert.deepEqual(outcome, { kind: "not_found" });
  });

  it("parcial, pero con la vía y la placa del resultado escritas sin «#» («kra 95a 42 141»): se ubica", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            partial_match: true,
            types: ["premise", "street_address"],
            formatted_address: "Cra. 95A # 42-141, Comuna 17, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.37369, lng: -76.51903 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "42-141", types: ["street_number"] },
              { long_name: "Carrera 95A", types: ["route"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "kra 95a 42 141",
    );
    assert.equal(outcome.kind, "found");
  });

  it("parcial con números que no son los del resultado («kra 95a 41 141»): no se ubica", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            partial_match: true,
            types: ["premise", "street_address"],
            formatted_address: "Cra. 95A # 42-141, Comuna 17, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.37369, lng: -76.51903 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "42-141", types: ["street_number"] },
              { long_name: "Carrera 95A", types: ["route"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "kra 95a 41 141",
    );
    assert.deepEqual(outcome, { kind: "not_found" });
  });

  it("un lugar con nombre que Google encuentra completo sí se ubica", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            types: ["establishment", "point_of_interest"],
            formatted_address: "Cra. 98 #16-200, Comuna 17, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.36893, lng: -76.52834 }, location_type: "ROOFTOP" },
            address_components: [{ long_name: "Cali", types: ["locality"] }],
          },
        ],
      },
      "Centro Comercial Jardín Plaza",
    );
    assert.equal(outcome.kind, "found");
  });

  it("si la vía del resultado tiene otro número, coincidir en la placa no basta", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            types: ["beauty_salon", "establishment", "point_of_interest"],
            formatted_address: "Cra 94A #42-64, Comuna 17, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.37437, lng: -76.51961 }, location_type: "ROOFTOP" },
            address_components: [
              { long_name: "42-64", types: ["street_number"] },
              { long_name: "Carrera 94A", types: ["route"] },
              { long_name: "Cali", types: ["locality"] },
            ],
          },
        ],
      },
      "Carrera 97 # 42-10, Calicanto",
    );
    assert.deepEqual(outcome, { kind: "not_found" });
  });

  it("una esquina («Calle 42 con Carrera 85C») es un punto exacto aunque Google la dé como centro", () => {
    const outcome = interpretGeocode(
      {
        status: "OK",
        results: [
          {
            types: ["intersection"],
            formatted_address: "Cl. 42 & Cra 85c, Comuna 17, Cali, Valle del Cauca, Colombia",
            geometry: { location: { lat: 3.38086, lng: -76.52026 }, location_type: "GEOMETRIC_CENTER" },
            address_components: [{ long_name: "Cali", types: ["locality"] }],
          },
        ],
      },
      "Calle 42 con Carrera 85C",
    );
    assert.deepEqual(outcome, { kind: "found", location: { lat: 3.38086, lng: -76.52026 }, neighborhood: null });
  });
});
