import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { haversineKm } from "./dispatch/haversine";
import { createRoadRouter, ROAD_RETRY_AFTER_MS, straightRouteKm } from "./road-distance";

const RESTAURANTE = { lat: 3.4372, lng: -76.5225 };
const CLIENTE = { lat: 3.4516, lng: -76.532 };

/** Un OSRM que mide la calle como la línea recta × `factor`. */
function osrm(factor = 1.55, snap = 4) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const [a, b] = url.split("/driving/")[1].split("?")[0].split(";").map((c) => c.split(",").map(Number));
    const meters = haversineKm({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] }) * 1000 * factor;
    return { ok: true, status: 200, json: async () => ({ code: "Ok", routes: [{ distance: meters }], waypoints: [{ distance: snap }, { distance: snap }] }) };
  };
  return { calls, fetch };
}

const quiet = () => {};

describe("createRoadRouter: km por calle con respaldo", () => {
  it("con OSRM, devuelve sus km con un decimal y fuente calle", async () => {
    const { fetch, calls } = osrm(1.55);
    const r = await createRoadRouter({ url: "http://osrm:5000/", fetch, log: quiet }).distance(RESTAURANTE, CLIENTE);
    assert.equal(r.source, "calle");
    assert.equal(r.km, Math.round(haversineKm(RESTAURANTE, CLIENTE) * 1.55 * 10) / 10);
    assert.match(calls[0], /^http:\/\/osrm:5000\/route\/v1\/driving\/-76\.5225,3\.4372;-76\.532,3\.4516\?/);
  });

  it("sin URL de OSRM, la línea recta × 1,3 de siempre", async () => {
    const r = await createRoadRouter({ url: "", log: quiet }).distance(RESTAURANTE, CLIENTE);
    assert.deepEqual(r, { km: straightRouteKm(RESTAURANTE, CLIENTE), source: "linea_recta" });
  });

  it("si OSRM no responde: respaldo sin error, y la caída queda registrada una vez", async () => {
    const logs: string[] = [];
    const router = createRoadRouter({
      url: "http://osrm:5000",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      log: (m) => logs.push(m),
    });
    const r = await router.distance(RESTAURANTE, CLIENTE);
    assert.deepEqual(r, { km: straightRouteKm(RESTAURANTE, CLIENTE), source: "linea_recta" });
    await router.distance(RESTAURANTE, CLIENTE);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /OSRM falló/);
  });

  it("si OSRM tarda más del límite, usa el respaldo sin esperar más", async () => {
    const router = createRoadRouter({
      url: "http://osrm:5000",
      timeoutMs: 30,
      // El temporizador de AbortSignal.timeout no mantiene vivo el proceso: sin
      // `alive`, Node no ve nada pendiente y cancela la prueba antes del aviso.
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          const alive = setTimeout(() => {}, 1_000);
          init.signal.addEventListener("abort", () => {
            clearTimeout(alive);
            reject(init.signal.reason);
          });
        }),
      log: quiet,
    });
    const started = Date.now();
    const r = await router.distance(RESTAURANTE, CLIENTE);
    assert.equal(r.source, "linea_recta");
    assert.ok(Date.now() - started < 1000);
  });

  it("tras una caída no le pregunta a OSRM hasta que pase el tiempo de reintento, y luego vuelve", async () => {
    let clock = 0;
    let up = false;
    const good = osrm();
    let calls = 0;
    const logs: string[] = [];
    const router = createRoadRouter({
      url: "http://osrm:5000",
      now: () => clock,
      log: (m) => logs.push(m),
      fetch: async (url) => {
        calls++;
        if (!up) return { ok: false, status: 502, json: async () => ({}) };
        return good.fetch(url);
      },
    });
    assert.equal((await router.distance(RESTAURANTE, CLIENTE)).source, "linea_recta");
    up = true;
    clock += ROAD_RETRY_AFTER_MS - 1;
    assert.equal((await router.distance(RESTAURANTE, CLIENTE)).source, "linea_recta");
    assert.equal(calls, 1);
    clock += 1;
    assert.equal((await router.distance(RESTAURANTE, CLIENTE)).source, "calle");
    assert.equal(calls, 2);
    assert.match(logs.at(-1)!, /volvió a responder/);
  });

  it("un punto lejos de toda calle del mapa se mide en línea recta, sin dar a OSRM por caído", async () => {
    const far = osrm(1.55, 2_000);
    const router = createRoadRouter({ url: "http://osrm:5000", fetch: far.fetch, log: quiet });
    assert.equal((await router.distance(RESTAURANTE, CLIENTE)).source, "linea_recta");
    assert.equal((await router.distance(RESTAURANTE, CLIENTE)).source, "linea_recta");
    assert.equal(far.calls.length, 2);
  });

  it("si no hay ruta (NoRoute), respaldo", async () => {
    const router = createRoadRouter({
      url: "http://osrm:5000",
      fetch: async () => ({ ok: false, status: 400, json: async () => ({ code: "NoRoute", message: "Impossible route" }) }),
      log: quiet,
    });
    assert.equal((await router.distance(RESTAURANTE, CLIENTE)).source, "linea_recta");
  });
});
