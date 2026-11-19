import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, createCourier, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  DELIVERY,
  getAssignment,
  getCourier,
  installMocks,
  outbox,
  PICKUP,
  plain,
  resetMocks,
  restoreMocks,
  sentTo,
  setAssignment,
  world,
  type World,
} from "@/test-support/bot-env";

/**
 * `/api/gps`: lo que le llega de los celulares de los motorizados (Traccar
 * Client), en sus tres formatos, y lo que el bot saca de ahí (`bot/gps.ts`):
 * la última posición y, solo con verla moverse, que salió, que llegó a la
 * recogida, que se llevó el pedido, que llegó a la entrega y que se fue sin
 * marcarla. Se llama a la ruta tal cual, contra la base de pruebas. Sin
 * `TEST_DATABASE_URL` se salta.
 *
 * Los reportes de detección llevan hora del celular de hace dos horas: así el
 * bot respeta la hora que dicen (un celular atrasado más de un minuto conserva
 * su hora) y las esperas de 60 s se pueden armar sin esperar de verdad.
 */

type Route = typeof import("./route");
let route: Route;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  route = await import("./route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

const URL_BASE = "http://bot.test/api/gps";
const DEVICE = "traccar-d3f1c0de";
/** El «principio» de los reportes de detección: hace dos horas, en milisegundos. */
const T0 = Date.now() - 2 * 60 * 60_000;
/** Segundos desde T0 → milisegundos. */
const at = (seconds: number) => T0 + seconds * 1000;
/** Un punto a esa cantidad de metros al norte de otro. */
const north = (p: { lat: number; lng: number }, meters: number) => ({ lat: p.lat + meters / 111_195, lng: p.lng });

async function withDevice(w: World, deviceId = DEVICE) {
  await db.insert(schema.courierProfiles).values({ courierId: w.courier.id, gpsDeviceId: deviceId });
}

type Fix = { id?: string | null; lat?: number | string | null; lon?: number | string | null; timestamp?: number | string | null; accuracy?: number | string; speed?: number | string; is_moving?: boolean | string; activity?: string };
const params = (fix: Fix) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries({ id: DEVICE, ...fix })) if (value !== null && value !== undefined) q.set(key, String(value));
  return q;
};
const get = (fix: Fix) => route.GET(new Request(`${URL_BASE}?${params(fix)}`));
const postForm = (fix: Fix, headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" }) =>
  route.POST(new Request(URL_BASE, { method: "POST", headers, body: params(fix).toString() }));
const postJson = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  route.POST(new Request(URL_BASE, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
const jsonFix = (lat: number, lng: number, extra: { timestamp?: unknown; accuracy?: number; speed?: number; is_moving?: boolean; activity?: string } = {}, deviceId = DEVICE) => ({
  device_id: deviceId,
  location: {
    timestamp: extra.timestamp,
    ...(extra.is_moving === undefined ? {} : { is_moving: extra.is_moving }),
    ...(extra.activity ? { activity: { type: extra.activity } } : {}),
    coords: { latitude: lat, longitude: lng, ...(extra.accuracy === undefined ? {} : { accuracy: extra.accuracy }), ...(extra.speed === undefined ? {} : { speed: extra.speed }) },
  },
});

async function ok(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");
}

/** Un reporte de detección: a esos metros al norte del punto, `seconds` después de T0. */
const report = (point: { lat: number; lng: number }, meters: number, seconds: number, extra: Fix = {}) => {
  const p = north(point, meters);
  return get({ lat: p.lat, lon: p.lng, timestamp: Math.floor(at(seconds) / 1000), ...extra });
};

describe("/api/gps (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("los tres formatos de Traccar Client", () => {
    it("GET con los datos en la URL (OsmAnd): guarda la posición con la hora del servidor si el reloj del celular está cerca", async () => {
      const w = await world();
      await withDevice(w);
      const before = Date.now();
      await ok(await get({ lat: 3.4516, lon: -76.5319, timestamp: Math.floor(Date.now() / 1000) - 10 }));
      const courier = await getCourier(w.courier.id);
      assert.deepEqual([courier.lat, courier.lng], [3.4516, -76.5319]);
      assert.ok(courier.locationUpdatedAt && courier.locationUpdatedAt.getTime() >= before, "hora del servidor, no la del celular (10 s atrás)");
    });

    it("sin hora en el reporte usa la del servidor", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await get({ lat: 3.45, lon: -76.53 }));
      assert.ok(Date.now() - (await getCourier(w.courier.id)).locationUpdatedAt!.getTime() < 5_000);
    });

    it("también con `deviceid` en vez de `id`", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await route.GET(new Request(`${URL_BASE}?deviceid=${DEVICE}&lat=3.5&lon=-76.5`)));
      assert.equal((await getCourier(w.courier.id)).lat, 3.5);
    });

    it("POST con los datos en el cuerpo (la versión nueva de la app), con o sin Content-Type", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await postForm({ lat: 3.46, lon: -76.52 }));
      assert.equal((await getCourier(w.courier.id)).lat, 3.46);
      await ok(await postForm({ lat: 3.47, lon: -76.51 }, {}));
      assert.equal((await getCourier(w.courier.id)).lat, 3.47);
    });

    it("POST JSON: device_id y location.coords", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await postJson(jsonFix(3.48, -76.5)));
      const courier = await getCourier(w.courier.id);
      assert.deepEqual([courier.lat, courier.lng], [3.48, -76.5]);
    });

    it("el JSON también vale si la app no manda el Content-Type de JSON", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await postJson(jsonFix(3.49, -76.5), { "Content-Type": "text/plain" }));
      assert.equal((await getCourier(w.courier.id)).lat, 3.49);
      await ok(await postJson(`  ${JSON.stringify(jsonFix(3.491, -76.5))}  `, {}));
      assert.equal((await getCourier(w.courier.id)).lat, 3.491);
    });

    it("al recuperar la señal pueden llegar varias posiciones juntas: vale la última", async () => {
      const w = await world();
      await withDevice(w);
      const body = {
        device_id: DEVICE,
        location: [
          { coords: { latitude: 3.1, longitude: -76.1 } },
          { coords: { latitude: 3.2, longitude: -76.2 } },
          { coords: { latitude: 3.3, longitude: -76.3 } },
        ],
      };
      await ok(await postJson(body));
      const courier = await getCourier(w.courier.id);
      assert.deepEqual([courier.lat, courier.lng], [3.3, -76.3]);
    });

    it("lo que viene en la URL manda sobre el cuerpo", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await route.POST(new Request(`${URL_BASE}?id=${DEVICE}&lat=3.51&lon=-76.51`, { method: "POST", body: JSON.stringify(jsonFix(9, 9)) })));
      assert.equal((await getCourier(w.courier.id)).lat, 3.51);
    });

    it("la hora llega en segundos, en milisegundos o en texto ISO", async () => {
      const w = await world();
      await withDevice(w);
      const base = at(0);
      await ok(await get({ lat: 3.4, lon: -76.4, timestamp: Math.floor(base / 1000) }));
      assert.equal((await getCourier(w.courier.id)).locationUpdatedAt?.getTime(), Math.floor(base / 1000) * 1000);
      await ok(await get({ lat: 3.41, lon: -76.4, timestamp: base + 60_000 }));
      assert.equal((await getCourier(w.courier.id)).locationUpdatedAt?.getTime(), base + 60_000);
      await ok(await get({ lat: 3.42, lon: -76.4, timestamp: new Date(base + 120_000).toISOString() }));
      assert.equal((await getCourier(w.courier.id)).locationUpdatedAt?.getTime(), base + 120_000);
    });
  });

  describe("descarte silencioso: siempre 200, para que Traccar no reintente para siempre", () => {
    async function untouched(w: World) {
      const courier = await getCourier(w.courier.id);
      assert.deepEqual([courier.lat, courier.lng, courier.locationUpdatedAt], [null, null, null]);
      assert.equal(outbox.length, 0);
    }

    it("un identificador que no conocemos: 200 y no cambia a nadie", async () => {
      const w = await world();
      await withDevice(w);
      const other = await createCourier({ name: "Luis" });
      await ok(await get({ id: "traccar-desconocido", lat: 3.45, lon: -76.53 }));
      await ok(await postJson(jsonFix(3.45, -76.53, {}, "traccar-desconocido")));
      await untouched(w);
      assert.equal((await getCourier(other.id)).lat, null);
    });

    it("el identificador distingue mayúsculas y no vale por parecido", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await get({ id: DEVICE.toUpperCase(), lat: 3.45, lon: -76.53 }));
      await ok(await get({ id: DEVICE.slice(0, -1), lat: 3.45, lon: -76.53 }));
      await ok(await get({ id: `${DEVICE}x`, lat: 3.45, lon: -76.53 }));
      await untouched(w);
    });

    it("un motorizado desactivado: se ignora", async () => {
      const w = await world();
      await withDevice(w);
      await db.update(schema.couriers).set({ active: false }).where(eq(schema.couriers.id, w.courier.id));
      await ok(await get({ lat: 3.45, lon: -76.53 }));
      await untouched(w);
    });

    for (const [name, fix] of [
      ["sin identificador", { id: null, lat: 3.45, lon: -76.53 }],
      ["con el identificador vacío", { id: "", lat: 3.45, lon: -76.53 }],
      ["sin latitud", { lat: null, lon: -76.53 }],
      ["sin longitud", { lat: 3.45, lon: null }],
      ["con una latitud que no es número", { lat: "norte", lon: -76.53 }],
      ["con la latitud fuera de rango (> 90)", { lat: 91, lon: -76.53 }],
      ["con la latitud fuera de rango (< -90)", { lat: -91, lon: -76.53 }],
      ["con la longitud fuera de rango (> 180)", { lat: 3.45, lon: 181 }],
      ["con la longitud fuera de rango (< -180)", { lat: 3.45, lon: -181 }],
    ] as const) {
      it(`${name}: 200 y no guarda nada`, async () => {
        const w = await world();
        await withDevice(w);
        await ok(await get(fix as Fix));
        await untouched(w);
      });
    }

    it("un cuerpo que no es JSON ni parámetros, o vacío: 200 y nada", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await postJson("{esto no es json"));
      await ok(await postJson(""));
      await ok(await postJson("hola mundo", {}));
      await ok(await postJson("{}"));
      await ok(await route.GET(new Request(URL_BASE)));
      await untouched(w);
    });

    it("una posición con más de 100 m de error no sirve para saber si llegó: se descarta", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await get({ lat: 3.45, lon: -76.53, accuracy: 101 }));
      await ok(await get({ lat: 3.45, lon: -76.53, accuracy: "abc" }));
      await untouched(w);
    });

    it("hasta 100 m de error (y sin dato de error) sí vale", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await get({ lat: 3.41, lon: -76.53, accuracy: 100, timestamp: Math.floor(at(0) / 1000) }));
      assert.equal((await getCourier(w.courier.id)).lat, 3.41);
      await ok(await get({ lat: 3.42, lon: -76.53, accuracy: 5, timestamp: Math.floor(at(60) / 1000) }));
      assert.equal((await getCourier(w.courier.id)).lat, 3.42);
      await ok(await postJson(jsonFix(3.43, -76.53, { accuracy: 20, timestamp: at(120) })));
      assert.equal((await getCourier(w.courier.id)).lat, 3.43);
    });
  });

  describe("hora del reporte", () => {
    it("un celular atrasado más de un minuto conserva su hora (el reporte ya es viejo)", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await get({ lat: 3.45, lon: -76.53, timestamp: Math.floor(at(0) / 1000) }));
      assert.equal((await getCourier(w.courier.id)).locationUpdatedAt?.getTime(), Math.floor(at(0) / 1000) * 1000);
    });

    it("un celular adelantado no deja a la moto «en vivo» de más: se usa la hora del servidor", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await get({ lat: 3.45, lon: -76.53, timestamp: Math.floor(Date.now() / 1000) + 600 }));
      const stored = (await getCourier(w.courier.id)).locationUpdatedAt!.getTime();
      assert.ok(Math.abs(stored - Date.now()) < 5_000);
    });

    it("un reporte más viejo que el último se ignora: no retrocede la posición", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await get({ lat: 3.5, lon: -76.5, timestamp: Math.floor(at(600) / 1000) }));
      await ok(await get({ lat: 3.4, lon: -76.4, timestamp: Math.floor(at(300) / 1000) }));
      assert.equal((await getCourier(w.courier.id)).lat, 3.5);
      await ok(await get({ lat: 3.6, lon: -76.6, timestamp: Math.floor(at(900) / 1000) }));
      assert.equal((await getCourier(w.courier.id)).lat, 3.6);
    });

    it("un reporte de la misma hora que el anterior no lo reemplaza", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await get({ lat: 3.5, lon: -76.5, timestamp: Math.floor(at(0) / 1000) }));
      await ok(await get({ lat: 3.6, lon: -76.6, timestamp: Math.floor(at(0) / 1000) }));
      assert.equal((await getCourier(w.courier.id)).lat, 3.5);
    });

    it("un reporte viejo no dispara la detección de llegada", async () => {
      const w = await world();
      await withDevice(w);
      const { trip } = await assignedTrip(w);
      await report(PICKUP, 1500, 600);
      await report(PICKUP, 20, 300);
      assert.equal((await getAssignment(trip.id)).atPickupAt, null);
    });
  });

  describe("si se mueve o está quieta", () => {
    const moving = async (w: World) => (await getCourier(w.courier.id)).locationMoving;

    it("is_moving manda sobre todo lo demás", async () => {
      const w = await world();
      await withDevice(w);
      await get({ lat: 3.4, lon: -76.5, timestamp: Math.floor(at(0) / 1000), is_moving: "true", speed: 0 });
      assert.equal(await moving(w), true);
      await get({ lat: 3.4, lon: -76.5, timestamp: Math.floor(at(60) / 1000), is_moving: "false", speed: 20 });
      assert.equal(await moving(w), false);
    });

    it("sin is_moving, la actividad: «still» es quieta y cualquier otra, en movimiento", async () => {
      const w = await world();
      await withDevice(w);
      await get({ lat: 3.4, lon: -76.5, timestamp: Math.floor(at(0) / 1000), activity: "still" });
      assert.equal(await moving(w), false);
      await get({ lat: 3.4, lon: -76.5, timestamp: Math.floor(at(60) / 1000), activity: "on_bicycle" });
      assert.equal(await moving(w), true);
    });

    it("sin eso, la velocidad: más de 0,5 m/s es movimiento", async () => {
      const w = await world();
      await withDevice(w);
      await get({ lat: 3.4, lon: -76.5, timestamp: Math.floor(at(0) / 1000), speed: 3 });
      assert.equal(await moving(w), true);
      await get({ lat: 3.4, lon: -76.5, timestamp: Math.floor(at(60) / 1000), speed: 0.2 });
      assert.equal(await moving(w), false);
    });

    it("sin ningún indicador, el primer reporte queda sin dato y el siguiente se compara con el anterior (15 m)", async () => {
      const w = await world();
      await withDevice(w);
      await get({ lat: 3.4, lon: -76.5, timestamp: Math.floor(at(0) / 1000) });
      assert.equal(await moving(w), null);
      const far = north({ lat: 3.4, lng: -76.5 }, 100);
      await get({ lat: far.lat, lon: far.lng, timestamp: Math.floor(at(60) / 1000) });
      assert.equal(await moving(w), true);
      const near = north(far, 5);
      await get({ lat: near.lat, lon: near.lng, timestamp: Math.floor(at(120) / 1000) });
      assert.equal(await moving(w), false);
    });
  });

  describe("lo que se sabe solo con verla moverse (gps.ts)", () => {
    it("sin pedidos encima solo se guarda la posición", async () => {
      const w = await world();
      await withDevice(w);
      await ok(await report(PICKUP, 30, 0));
      assert.ok((await getCourier(w.courier.id)).lat);
      assert.equal(outbox.length, 0);
    });

    describe("hacia la recogida", () => {
      it("el primer reporte guarda a qué distancia estaba; acercarse 200 m o más cuenta como «Voy en camino»", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await report(PICKUP, 1000, 0);
        const first = await getAssignment(trip.id);
        assert.ok(Math.abs(first.startDistanceM! - 1000) < 5);
        assert.equal(first.seenAt, null);
        await report(PICKUP, 900, 60);
        assert.equal((await getAssignment(trip.id)).seenAt, null, "100 m más cerca no alcanza");
        await report(PICKUP, 700, 120);
        assert.equal((await getAssignment(trip.id)).seenAt?.getTime(), Math.floor(at(120) / 1000) * 1000);
        await report(PICKUP, 400, 180);
        assert.equal((await getAssignment(trip.id)).seenAt?.getTime(), Math.floor(at(120) / 1000) * 1000, "la hora no se repite");
        assert.equal(outbox.length, 0, "salir no manda ningún mensaje");
      });

      it("a 100 m o menos de la recogida llegó; la hora de llegada es la del primer reporte", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await report(PICKUP, 50, 0);
        const arrived = (await getAssignment(trip.id)).atPickupAt;
        assert.equal(arrived?.getTime(), Math.floor(at(0) / 1000) * 1000);
        await report(PICKUP, 60, 30);
        assert.equal((await getAssignment(trip.id)).atPickupAt?.getTime(), arrived?.getTime(), "un segundo reporte no la repite");
      });

      it("a más de 100 m todavía no llegó", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await report(PICKUP, 130, 0);
        assert.equal((await getAssignment(trip.id)).atPickupAt, null);
      });

      it("respeta el radio de llegada que configure la agencia", async () => {
        const w = await world();
        await withDevice(w);
        await db.insert(schema.settings).values({ key: "bot_config", value: { gpsArrivalMeters: 30 } });
        const { trip } = await assignedTrip(w);
        await report(PICKUP, 50, 0);
        assert.equal((await getAssignment(trip.id)).atPickupAt, null);
        await report(PICKUP, 20, 30);
        assert.ok((await getAssignment(trip.id)).atPickupAt);
      });

      it("el rebote del GPS en el borde (entre 100 y 150 m) no cuenta como salir", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await report(PICKUP, 50, 0);
        await report(PICKUP, 130, 120);
        const a = await getAssignment(trip.id);
        assert.ok(a.atPickupAt, "sigue en el punto");
        assert.equal(a.pickedUpAt, null);
      });

      it("se fue de la recogida después de esperar un rato: se llevó el pedido, y le llega el mensaje 2 con el aviso del GPS", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await report(PICKUP, 50, 0);
        assert.equal(outbox.length, 0);
        await report(PICKUP, 200, 90);
        const a = await getAssignment(trip.id);
        assert.equal(a.pickedUpAt?.getTime(), Math.floor(at(90) / 1000) * 1000);
        const [msg] = sentTo(w.courier.phone);
        assert.match(plain(msg.text), /Perfecto, ahora lleva el pedido/);
        assert.match(plain(msg.text), /¿Te llevaste el datáfono o quedaste debiendo la comida\? Escríbeme «llevo datáfono» o «quedé debiendo»\./);
        assert.deepEqual(msg.buttons.map((b) => b.id), [`done:customer:finish:${trip.id}`, `done:gate:finish:${trip.id}`, `noanswer:${trip.id}`]);
        assert.equal(outbox.length, 1, "un solo mensaje");
      });

      it("solo pasó por ahí (menos de un minuto): no se llevó nada", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await report(PICKUP, 50, 0);
        await report(PICKUP, 300, 20);
        const a = await getAssignment(trip.id);
        assert.equal(a.pickedUpAt, null);
        assert.equal(a.atPickupAt, null, "la llegada se borra");
        assert.equal(outbox.length, 0);
      });

      it("se fue antes de que la comida pudiera estar lista: tampoco", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w, { readyAt: new Date(at(30 * 60)) });
        await report(PICKUP, 50, 0);
        await report(PICKUP, 300, 120);
        const a = await getAssignment(trip.id);
        assert.equal(a.pickedUpAt, null);
        assert.equal(a.atPickupAt, null);
      });

      it("con la comida lista (o a menos de 2 minutos de estarlo) sí se la llevó", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w, { readyAt: new Date(at(120 + 90)) });
        await report(PICKUP, 50, 0);
        await report(PICKUP, 300, 120);
        assert.ok((await getAssignment(trip.id)).pickedUpAt, "faltaban 90 s: el margen de 2 minutos lo cubre");
      });

      it("el dato de la recogida y el de la entrega no se mezclan: sin recogida ubicada no se detecta nada", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w, { pickupLocation: null });
        await report(PICKUP, 20, 0);
        await report(PICKUP, 600, 120);
        const a = await getAssignment(trip.id);
        assert.deepEqual([a.startDistanceM, a.atPickupAt, a.pickedUpAt], [null, null, null]);
      });
    });

    describe("hacia la entrega", () => {
      async function carrying(w: World) {
        const { trip } = await assignedTrip(w);
        await setAssignment(trip.id, { seenAt: new Date(at(-600)), pickedUpAt: new Date(at(-300)) });
        return trip;
      }

      it("llegó al punto de entrega: queda la hora", async () => {
        const w = await world();
        await withDevice(w);
        const trip = await carrying(w);
        await report(DELIVERY, 40, 0);
        assert.equal((await getAssignment(trip.id)).atDeliveryAt?.getTime(), Math.floor(at(0) / 1000) * 1000);
      });

      it("se fue sin marcar la entrega después de esperar: queda la hora de salida (de ahí sale la alerta)", async () => {
        const w = await world();
        await withDevice(w);
        const trip = await carrying(w);
        await report(DELIVERY, 40, 0);
        await report(DELIVERY, 250, 120);
        const a = await getAssignment(trip.id);
        assert.equal(a.leftDeliveryAt?.getTime(), Math.floor(at(120) / 1000) * 1000);
        assert.ok(a.atDeliveryAt, "la llegada se conserva");
        assert.equal(outbox.length, 0, "no se le escribe: solo queda la alerta en el tablero");
      });

      it("si vuelve al punto, la alerta de que se había ido ya no aplica", async () => {
        const w = await world();
        await withDevice(w);
        const trip = await carrying(w);
        await report(DELIVERY, 40, 0);
        await report(DELIVERY, 250, 120);
        assert.ok((await getAssignment(trip.id)).leftDeliveryAt);
        await report(DELIVERY, 30, 240);
        assert.equal((await getAssignment(trip.id)).leftDeliveryAt, null);
      });

      it("solo pasó frente a la entrega (menos de un minuto): se borra la llegada", async () => {
        const w = await world();
        await withDevice(w);
        const trip = await carrying(w);
        await report(DELIVERY, 40, 0);
        await report(DELIVERY, 250, 20);
        const a = await getAssignment(trip.id);
        assert.equal(a.atDeliveryAt, null);
        assert.equal(a.leftDeliveryAt, null);
      });

      it("antes de recoger, estar cerca de la entrega no cuenta", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await report(DELIVERY, 20, 0);
        assert.equal((await getAssignment(trip.id)).atDeliveryAt, null);
      });
    });

    describe("varios pedidos y casos aparte", () => {
      it("cada pedido que lleva se revisa con el mismo reporte", async () => {
        const w = await world();
        await withDevice(w);
        const first = await assignedTrip(w);
        const second = await assignedTrip(w);
        await report(PICKUP, 40, 0);
        assert.ok((await getAssignment(first.trip.id)).atPickupAt);
        assert.ok((await getAssignment(second.trip.id)).atPickupAt);
      });

      it("lo ya entregado no se revisa", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await setAssignment(trip.id, { seenAt: new Date(at(-600)), pickedUpAt: new Date(at(-300)) });
        const { deliverTrip } = await import("@dispatch/shared/db");
        await deliverTrip(trip.id, { place: "customer" });
        await report(DELIVERY, 20, 0);
        assert.equal((await getAssignment(trip.id)).atDeliveryAt, null);
      });

      it("cada motorizado con su identificador: el reporte de uno no mueve al otro", async () => {
        const first = await world();
        const second = await world({ courier: { name: "Luis Pérez" } });
        await withDevice(first, "traccar-uno");
        await withDevice(second, "traccar-dos");
        const a = await assignedTrip(first);
        const b = await assignedTrip(second);
        await report(PICKUP, 40, 0, { id: "traccar-uno" });
        assert.ok((await getAssignment(a.trip.id)).atPickupAt);
        assert.equal((await getAssignment(b.trip.id)).atPickupAt, null);
        assert.equal((await getCourier(second.courier.id)).lat, null);
      });

      it("dos reportes seguidos del mismo instante a la vez no repiten la marca ni el mensaje", async () => {
        const w = await world();
        await withDevice(w);
        const { trip } = await assignedTrip(w);
        await report(PICKUP, 50, 0);
        await Promise.all([report(PICKUP, 200, 90), report(PICKUP, 200, 91)]);
        assert.ok((await getAssignment(trip.id)).pickedUpAt);
        assert.equal(sentTo(w.courier.phone).filter((m) => /Perfecto, ahora lleva/.test(m.text)).length, 1, "el mensaje 2 sale una sola vez");
      });
    });
  });
});
