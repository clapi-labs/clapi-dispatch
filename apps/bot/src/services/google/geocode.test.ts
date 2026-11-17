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
