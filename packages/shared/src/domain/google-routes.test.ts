import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGoogleRoutes, createLiveRouter, GOOGLE_ROUTES_URL, shortestRouteKm } from "./google-routes";
import { createRoadRouter, straightRouteKm } from "./road-distance";

const A = { lat: 3.3605, lng: -76.516 };
const B = { lat: 3.3419, lng: -76.54779 };

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function googleWith(respond: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>, extra: { apiKey?: string; now?: () => number } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const google = createGoogleRoutes({
    apiKey: extra.apiKey ?? "llave",
    now: extra.now,
    log: (m) => logs.push(m),
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return respond();
    },
  });
  return { google, calls, logs };
}

const ok = (routes: { distanceMeters?: number }[]) => async () => ({ ok: true, status: 200, json: async () => ({ routes }) });

function osrmWith(meters: number | "caido") {
  let calls = 0;
  const router = createRoadRouter({
    url: "http://osrm:5000",
    log: () => {},
    fetch: async () => {
      calls++;
      if (meters === "caido") throw new TypeError("fetch failed");
      return { ok: true, status: 200, json: async () => ({ code: "Ok", routes: [{ distance: meters }], waypoints: [] }) };
    },
  });
  return { router, calls: () => calls };
}

describe("shortestRouteKm", () => {
  it("toma la ruta de menor distancia entre las alternativas", () => {
    assert.equal(shortestRouteKm([{ distanceMeters: 8730 }, { distanceMeters: 7180 }, { distanceMeters: 7800 }]), 7.2);
  });
  it("redondea a un decimal", () => {
    assert.equal(shortestRouteKm([{ distanceMeters: 7149 }]), 7.1);
    assert.equal(shortestRouteKm([{ distanceMeters: 7151 }]), 7.2);
  });
  it("sin rutas válidas: null", () => {
    assert.equal(shortestRouteKm([]), null);
    assert.equal(shortestRouteKm(undefined), null);
    assert.equal(shortestRouteKm([{}, { distanceMeters: Number.NaN }]), null);
  });
});

describe("createGoogleRoutes", () => {
  it("pide el nivel Essentials: DRIVE, sin tráfico, alternativas y solo distanceMeters", async () => {
    const { google, calls } = googleWith(ok([{ distanceMeters: 7200 }]));
    assert.equal(await google.distance(A, B), 7.2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, GOOGLE_ROUTES_URL);
    assert.equal(calls[0].headers["X-Goog-FieldMask"], "routes.distanceMeters");
    assert.equal(calls[0].headers["X-Goog-Api-Key"], "llave");
    assert.equal(calls[0].body.travelMode, "DRIVE");
    assert.equal(calls[0].body.routingPreference, "TRAFFIC_UNAWARE");
    assert.equal(calls[0].body.computeAlternativeRoutes, true);
  });

  it("sin llave: null y no llama a Google", async () => {
    const { google, calls } = googleWith(ok([{ distanceMeters: 7200 }]), { apiKey: "" });
    assert.equal(await google.distance(A, B), null);
    assert.equal(calls.length, 0);
  });

  it("HTTP 4xx/5xx/429: null, y no vuelve a preguntar durante la pausa", async () => {
    for (const status of [403, 429, 500]) {
      let t = 0;
      const { google, calls, logs } = googleWith(async () => ({ ok: false, status, json: async () => ({ error: { status: "X", message: "m" } }) }), { now: () => t });
      assert.equal(await google.distance(A, B), null);
      assert.equal(await google.distance(A, B), null);
      assert.equal(calls.length, 1, `status ${status}`);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /^\[calles\] Google Routes falló/);
      t = 31_000;
      await google.distance(A, B);
      assert.equal(calls.length, 2);
    }
  });

  it("tiempo agotado: null", async () => {
    const { google, logs } = googleWith(async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });
    assert.equal(await google.distance(A, B), null);
    assert.match(logs[0], /no respondió en 1500 ms/);
  });

  it("200 sin rutas: null, sin dar a Google por caído", async () => {
    const { google, calls } = googleWith(ok([]));
    assert.equal(await google.distance(A, B), null);
    assert.equal(await google.distance(A, B), null);
    assert.equal(calls.length, 2);
  });
});

describe("cascada Google → OSRM → línea recta × 1,3", () => {
  it("Google responde: source google, OSRM ni se consulta", async () => {
    const { google } = googleWith(ok([{ distanceMeters: 8730 }, { distanceMeters: 7200 }]));
    const osrm = osrmWith(8730);
    const r = await createLiveRouter(google, osrm.router).distance(A, B);
    assert.deepEqual(r, { km: 7.2, source: "google", routable: true });
    assert.equal(osrm.calls(), 0);
  });

  it("Google falla: OSRM", async () => {
    const { google } = googleWith(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const r = await createLiveRouter(google, osrmWith(8730).router).distance(A, B);
    assert.deepEqual(r, { km: 8.7, source: "calle", routable: true });
  });

  it("sin llave: OSRM", async () => {
    const { google, calls } = googleWith(ok([{ distanceMeters: 7200 }]), { apiKey: "" });
    const r = await createLiveRouter(google, osrmWith(8730).router).distance(A, B);
    assert.equal(r.source, "calle");
    assert.equal(calls.length, 0);
  });

  it("Google y OSRM caídos: línea recta × 1,3, sin error", async () => {
    const { google } = googleWith(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await createLiveRouter(google, osrmWith("caido").router).distance(A, B);
    assert.deepEqual(r, { km: straightRouteKm(A, B), source: "linea_recta", routable: true });
  });
});
