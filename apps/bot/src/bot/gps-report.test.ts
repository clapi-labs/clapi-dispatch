import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readReport } from "./gps-report";

const URL_GPS = "https://bot.ejemplo.test/api/gps";
const post = (body: string, type: string, query = "") => new Request(`${URL_GPS}${query}`, { method: "POST", body, headers: { "content-type": type } });

describe("lo que manda Traccar Client", () => {
  it("lee los datos en la URL (protocolo OsmAnd)", async () => {
    const r = await readReport(new Request(`${URL_GPS}?id=moto-prueba&lat=3.42&lon=-76.52&timestamp=1790000000&accuracy=8`, { method: "POST" }));
    assert.deepEqual({ id: r.id, lat: r.lat, lng: r.lng, accuracy: r.accuracy, at: r.at.getTime() }, { id: "moto-prueba", lat: 3.42, lng: -76.52, accuracy: 8, at: 1790000000_000 });
  });

  it("lee los datos en el cuerpo del POST, como los manda la versión nueva de la app", async () => {
    const body = "id=moto-prueba&lat=3.42&lon=-76.52&timestamp=1790000000&accuracy=10.861000061035156&altitude=1000&batt=40&charge=false";
    for (const type of ["application/x-www-form-urlencoded", "application/json", "text/plain"]) {
      const r = await readReport(post(body, type));
      assert.equal(r.id, "moto-prueba", type);
      assert.equal(r.lat, 3.42, type);
      assert.equal(r.lng, -76.52, type);
      assert.equal(r.accuracy, 10.861000061035156, type);
      assert.equal(r.at.getTime(), 1790000000_000, type);
    }
  });

  it("lee el formato JSON y se queda con la última posición si llegan varias", async () => {
    const body = JSON.stringify({
      device_id: "moto-prueba",
      location: [
        { timestamp: "2026-11-11T10:00:00Z", coords: { latitude: 3.41, longitude: -76.51, accuracy: 30 } },
        { timestamp: "2026-11-11T10:00:10Z", coords: { latitude: 3.42, longitude: -76.52, accuracy: 6 } },
      ],
    });
    const r = await readReport(post(body, "application/json"));
    assert.deepEqual({ id: r.id, lat: r.lat, lng: r.lng, accuracy: r.accuracy, at: r.at.toISOString() }, { id: "moto-prueba", lat: 3.42, lng: -76.52, accuracy: 6, at: "2026-11-11T10:00:10.000Z" });
  });

  it("un cuerpo vacío o roto no tiene identificador ni posición", async () => {
    for (const body of ["", "{roto", "hola"]) {
      const r = await readReport(post(body, "application/json"));
      assert.equal(r.id, null);
      assert.ok(Number.isNaN(r.lat));
    }
  });
});
