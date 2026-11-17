import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRoadRouter } from "../domain/road-distance";
import { haversineKm } from "../domain/dispatch/haversine";
import { deliveryDistance, osrmRouter, routeKm } from "./quote";

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
    assert.deepEqual(r, { km: routeKm(RESTAURANTE, CLIENTE), source: "linea_recta", routable: true });
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
    assert.deepEqual(await deliveryDistance(RESTAURANTE, CLIENTE, { porCalle: true }, router), { km: routeKm(RESTAURANTE, CLIENTE), source: "linea_recta", routable: true });
  });

  it("encendido con un punto fuera del mapa: no se cotiza", async () => {
    const router = createRoadRouter({
      url: "http://osrm:5000",
      log: () => {},
      fetch: async () => ({ ok: false, status: 400, json: async () => ({ code: "NoRoute", message: "Impossible route" }) }),
    });
    assert.deepEqual(await deliveryDistance(RESTAURANTE, CLIENTE, { porCalle: true }, router), { km: 0, source: "linea_recta", routable: false });
  });
});

describe("tabla de ejemplos de Tarifas: nunca llama a Google", () => {
  it("con el OSRM propio y una llave puesta, no sale ninguna llamada a Google Routes", async () => {
    const real = globalThis.fetch;
    const urls: string[] = [];
    const previous = { key: process.env.GOOGLE_MAPS_API_KEY, osrm: process.env.OSRM_URL };
    process.env.GOOGLE_MAPS_API_KEY = "llave";
    process.env.OSRM_URL = "http://osrm:5000";
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 8730 }], waypoints: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const r = await deliveryDistance(RESTAURANTE, CLIENTE, { porCalle: true }, osrmRouter());
      assert.equal(r.source, "calle");
      assert.equal(urls.length, 1);
      assert.ok(urls.every((u) => !u.includes("googleapis.com")));
    } finally {
      globalThis.fetch = real;
      if (previous.key === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
      else process.env.GOOGLE_MAPS_API_KEY = previous.key;
      if (previous.osrm === undefined) delete process.env.OSRM_URL;
      else process.env.OSRM_URL = previous.osrm;
    }
  });

  it("fareExampleDistances mide con osrmRouter()", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./fare-examples.ts", import.meta.url), "utf8");
    assert.match(source, /measurer = osrmRouter\(\)/);
    assert.match(source, /config, measurer\)/);
  });
});
