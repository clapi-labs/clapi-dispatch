import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, createCourier, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  findPython,
  getAssignment,
  getTrip,
  installMocks,
  liveCourier,
  minutesAgo,
  outbox,
  pendingTrip,
  PICKUP,
  plain,
  resetMocks,
  restoreMocks,
  sentTo,
  startRealEngine,
  world,
} from "@/test-support/bot-env";

/**
 * El tick contra el engine DE VERDAD: el servicio Python de `apps/engine` (solo
 * librería estándar) levantado como proceso, con la base de pruebas y WhatsApp
 * simulado. Es la prueba de contrato entre las dos mitades: lo que el bot le
 * manda a `POST /evaluar` (`engine-request.ts`) y lo que entiende de la
 * respuesta (`engine.ts`). Las demás suites usan un engine de mentiras, que es
 * lo que permite probar sus fallas; esta comprueba que el de verdad y el bot
 * hablan el mismo idioma. Sin `TEST_DATABASE_URL`, o sin Python 3, se salta;
 * en CI (`REQUIRE_REAL_ENGINE=1`) falla en vez de saltarse.
 *
 * El engine de verdad despacha antes de que la comida esté lista (le resta lo
 * que tarda la moto), así que aquí los pedidos están ya listos.
 */

const python = findPython();
if (!python && process.env.REQUIRE_REAL_ENGINE === "1") throw new Error("REQUIRE_REAL_ENGINE=1 pero no hay Python 3 para levantar el engine real");
const skip = integrationSkip || (python ? false : "no hay Python 3");

type Dispatch = typeof import("./engine");
type Tick = typeof import("@/app/api/internal/tick/route");
let dispatch: Dispatch;
let tick: Tick;
let engine: Awaited<ReturnType<typeof startRealEngine>>;
const saved: Record<string, string | undefined> = {};
const SECRET = "secreto-interno-de-prueba";

before(async () => {
  if (skip) return;
  await installMocks();
  for (const key of ["ENGINE_URL", "INTERNAL_SECRET"]) saved[key] = process.env[key];
  engine = await startRealEngine();
  dispatch = await import("./engine");
  tick = await import("@/app/api/internal/tick/route");
});

beforeEach(async () => {
  if (skip) return;
  await resetDatabase();
  resetMocks();
  process.env.ENGINE_URL = engine.url;
  process.env.INTERNAL_SECRET = SECRET;
});

/** Un punto a esa cantidad de metros al norte de otro. */
const north = (p: { lat: number; lng: number }, meters: number) => ({ lat: p.lat + meters / 111_195, lng: p.lng });
const at = (meters: number) => {
  const p = north(PICKUP, meters);
  return { lat: p.lat, lng: p.lng };
};
const ready = () => ({ readyAt: minutesAgo(1) });
const evaluationOf = async (tripId: number) => (await db.select().from(schema.engineEvaluations).where(eq(schema.engineEvaluations.tripId, tripId)))[0];
const setting = (key: string, value: unknown) => db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
const runTick = async () => {
  const res = await tick.POST(new Request("http://bot.test/api/internal/tick", { method: "POST", headers: { "x-internal-secret": SECRET } }));
  assert.equal(res.status, 200);
  return (await res.json()) as { assigned: number[]; reminded: number[]; alerted: number };
};

describe("engine real (proceso Python) con el bot y Postgres", { skip }, () => {
  after(async () => {
    await engine?.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreMocks();
    await closeTestDatabase();
  });

  it("contesta su salud y su versión (la que el bot guarda con cada decisión)", () => {
    // `startRealEngine` ya esperó a `/health`: la versión es la que ese endpoint devolvió.
    assert.match(engine.version, /^\d{4}\.\d+\.\d+$/);
    assert.match(engine.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  describe("un tick completo con el engine de verdad", () => {
    it("elige a la moto más cercana, la asigna, avisa y deja la decisión explicada", async () => {
      const w = await world({ courier: liveCourier(at(200)) });
      const far = await createCourier({ name: "Luis Pérez", ...liveCourier(at(3_000)) });
      const trip = await pendingTrip(w, ready());

      const body = await runTick();
      assert.deepEqual(body.assigned, [trip.id]);
      assert.equal((await getAssignment(trip.id)).courierId, w.courier.id, "la de 200 m, no la de 3 km");
      assert.equal((await getTrip(trip.id)).status, "en_route");
      assert.equal((await db.select().from(schema.couriers).where(eq(schema.couriers.id, far.id)))[0].status, "available");

      const evaluation = await evaluationOf(trip.id);
      assert.equal(evaluation.status, "decided");
      assert.equal(evaluation.courierId, w.courier.id);
      assert.equal(evaluation.engineVersion, engine.version, "queda la versión del engine que decidió");
      const response = evaluation.response as { ganador: string; motos: { id: string; elegible: boolean; score: number }[] };
      assert.equal(response.ganador, String(w.courier.id));
      assert.equal(response.motos.length, 2, "el engine evaluó a las dos");
      assert.ok(response.motos.every((m) => m.elegible));
      const [route] = await db.select().from(schema.courierRoutes);
      assert.deepEqual(route.stops, [{ tipo: "R", pedido: trip.id }, { tipo: "C", pedido: trip.id }], "la ruta con el id del pedido (el engine manda `pedido: null` para el nuevo)");

      const [ticket] = sentTo(w.courier.phone);
      assert.match(plain(ticket.text), /Pedro, tienes un nuevo pedido/);
      assert.equal(sentTo(far.phone).length, 0, "la otra no recibe nada");
    });

    it("no asigna antes de hora: cuando la comida tarda, el pedido espera y dice cuánto falta", async () => {
      const w = await world({ courier: liveCourier(at(200)) });
      const trip = await pendingTrip(w, { readyAt: new Date(Date.now() + 40 * 60_000) });
      assert.deepEqual((await runTick()).assigned, []);
      const evaluation = await evaluationOf(trip.id);
      assert.equal(evaluation.status, "waiting");
      assert.match(evaluation.reason ?? "", /^Se despacha en \d+(\.\d+)? min$/);
      assert.ok((evaluation.faltanMin ?? 0) > 20, `faltan ${evaluation.faltanMin} min`);
      assert.equal((await getTrip(trip.id)).status, "pending");
      assert.equal(outbox.length, 0);
    });

    it("el pedido que esperaba se asigna cuando le llega la hora", async () => {
      const w = await world({ courier: liveCourier(at(200)) });
      const trip = await pendingTrip(w, { readyAt: new Date(Date.now() + 40 * 60_000) });
      await runTick();
      assert.equal((await getTrip(trip.id)).status, "pending");
      await db.update(schema.trips).set({ readyAt: minutesAgo(1) }).where(eq(schema.trips.id, trip.id));
      assert.deepEqual((await runTick()).assigned, [trip.id]);
      assert.equal((await evaluationOf(trip.id)).evaluations, 2);
    });

    it("sin motos con GPS: «sin GPS» con el motivo del engine", async () => {
      await world({ courier: liveCourier({ ...at(200), locationUpdatedAt: minutesAgo(10) }) }).then((w) => pendingTrip(w, ready()));
      assert.deepEqual((await runTick()).assigned, []);
      const [evaluation] = await db.select().from(schema.engineEvaluations);
      assert.equal(evaluation.reason, "Sin motos elegibles (sin GPS: 1)");
    });

    it("una moto demasiado lejos (fuera del radio) no es elegible", async () => {
      const w = await world({ courier: liveCourier(at(40_000)) });
      const trip = await pendingTrip(w, ready());
      assert.deepEqual((await runTick()).assigned, []);
      assert.equal((await evaluationOf(trip.id)).reason, "Sin motos elegibles (lejos: 1)");
    });

    it("la moto que ya lleva un pedido recibe otro (multipedido) y su ruta junta los dos", async () => {
      const w = await world({ courier: liveCourier(at(300)) });
      const first = await assignedTrip(w);
      const second = await pendingTrip(w, ready());
      const body = await runTick();
      assert.deepEqual(body.assigned, [second.id]);
      assert.equal((await getAssignment(second.id)).courierId, w.courier.id);
      const [route] = await db.select().from(schema.courierRoutes);
      const stops = route.stops as { tipo: string; pedido: number }[];
      assert.equal(stops.length, 4, "recoger y entregar, dos veces");
      for (const trip of [first.trip, second]) {
        for (const tipo of ["R", "C"]) assert.ok(stops.some((s) => s.tipo === tipo && s.pedido === trip.id), `${tipo} de ${trip.id}`);
      }
    });

    it("sin multipedido (radio y multipedido de engine_config), la moto ocupada no recibe otro", async () => {
      const w = await world({ courier: liveCourier(at(300)) });
      await assignedTrip(w);
      const second = await pendingTrip(w, ready());
      await setting("engine_config", { mode: "auto", multipedido: false });
      assert.deepEqual((await runTick()).assigned, []);
      assert.match((await evaluationOf(second.id)).reason ?? "", /^Sin motos elegibles \(ocupadas: 1\)$/);
    });

    it("con la demanda alta le pide el modo pico, y el engine lo devuelve en su respuesta", async () => {
      const w = await world({ courier: liveCourier(at(200)) });
      await db.insert(schema.demandState).values({ id: 1, level: "alta" });
      const trip = await pendingTrip(w, ready());
      await runTick();
      const evaluation = await evaluationOf(trip.id);
      assert.equal(evaluation.mode, "pico");
      assert.equal((evaluation.response as { modo: string }).modo, "pico");
    });

    it("dos ticks a la vez con el engine de verdad: una sola asignación", async () => {
      const w = await world({ courier: liveCourier(at(200)) });
      await createCourier({ name: "Luis Pérez", ...liveCourier(at(250)) });
      const trip = await pendingTrip(w, ready());
      const [a, b] = await Promise.all([runTick(), runTick()]);
      assert.deepEqual([...a.assigned, ...b.assigned], [trip.id]);
      assert.equal((await db.select().from(schema.assignments).where(eq(schema.assignments.tripId, trip.id))).length, 1);
      assert.equal(outbox.filter((m) => /nuevo pedido/.test(m.text)).length, 1);
    });
  });

  describe("el engine de verdad se cae de verdad", () => {
    /** Un engine real que se levantó y se apagó: su puerto queda sin nadie escuchando. */
    async function deadEngineUrl() {
      const dead = await startRealEngine();
      await dead.stop();
      return dead.url;
    }
    const quiet = async (work: () => Promise<unknown>) => {
      const original = console.error;
      console.error = () => {};
      try {
        await work();
      } finally {
        console.error = original;
      }
    };

    it("sin nadie escuchando (conexión rechazada): el tick no se cae y el pedido espera con el motivo", async () => {
      const w = await world({ courier: liveCourier(at(200)) });
      const trip = await pendingTrip(w, ready());
      process.env.ENGINE_URL = await deadEngineUrl();
      await quiet(async () => assert.deepEqual((await runTick()).assigned, []));
      assert.equal((await getTrip(trip.id)).status, "pending");
      assert.match((await evaluationOf(trip.id)).reason ?? "", /^Engine: fetch failed$/);
      assert.ok(w);
    });

    it("al volver el engine (en otro puerto), el pedido que esperaba se asigna en el siguiente tick", async () => {
      const w = await world({ courier: liveCourier(at(200)) });
      const trip = await pendingTrip(w, ready());
      process.env.ENGINE_URL = await deadEngineUrl();
      await quiet(() => runTick());
      assert.equal((await getTrip(trip.id)).status, "pending");

      const back = await startRealEngine();
      try {
        process.env.ENGINE_URL = back.url;
        assert.deepEqual((await runTick()).assigned, [trip.id]);
        assert.equal((await evaluationOf(trip.id)).evaluations, 2);
      } finally {
        await back.stop();
      }
      assert.ok(w);
    });
  });
});
