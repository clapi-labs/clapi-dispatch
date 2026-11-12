import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRoadRouter } from "../domain/road-distance";
import { haversineKm } from "../domain/dispatch/haversine";
import { deliveryDistance, routeKm } from "./quote";

/**
 * El interruptor `settings.routing_config.porCalle` (docs/DIRECCIONES-Y-ZONAS.md):
 * apagado, los km son exactamente los de siempre y OSRM ni se consulta.
 */

const RESTAURANTE = { lat: 3.4372, lng: -76.5225 };
const CLIENTE = { lat: 3.4516, lng: -76.532 };

function countingRouter(factor = 1.55) {
  let calls = 0;
  const router = createRoadRouter({
    url: "http://osrm:5000",
    log: () => {},
    fetch: async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ code: "Ok", routes: [{ distance: haversineKm(RESTAURANTE, CLIENTE) * 1000 * factor }], waypoints: [] }) };
    },
  });
  return { router, calls: () => calls };
}

describe("deliveryDistance: interruptor de km por calle", () => {
  it("apagado: línea recta × 1,3, como siempre, sin consultar OSRM", async () => {
    const { router, calls } = countingRouter();
    const r = await deliveryDistance(RESTAURANTE, CLIENTE, { porCalle: false }, router);
    assert.deepEqual(r, { km: routeKm(RESTAURANTE, CLIENTE), source: "linea_recta" });
    assert.equal(r.km, Math.round(haversineKm(RESTAURANTE, CLIENTE) * 1.3 * 10) / 10);
    assert.equal(calls(), 0);
  });

  it("encendido: los km por calle de OSRM", async () => {
    const { router, calls } = countingRouter(1.55);
    const r = await deliveryDistance(RESTAURANTE, CLIENTE, { porCalle: true }, router);
    assert.equal(r.source, "calle");
    assert.equal(r.km, Math.round(haversineKm(RESTAURANTE, CLIENTE) * 1.55 * 10) / 10);
    assert.equal(calls(), 1);
  });

  it("encendido con OSRM caído: los km de siempre, sin error", async () => {
    const router = createRoadRouter({
      url: "http://osrm:5000",
      log: () => {},
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.deepEqual(await deliveryDistance(RESTAURANTE, CLIENTE, { porCalle: true }, router), { km: routeKm(RESTAURANTE, CLIENTE), source: "linea_recta" });
  });
});
