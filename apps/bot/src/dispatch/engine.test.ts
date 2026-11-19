import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, createCourier, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  engine,
  engineCalls,
  fakeEngine,
  getAssignment,
  getTrip,
  installMocks,
  liveCourier,
  minutesAgo,
  pendingTrip,
  resetMocks,
  restoreMocks,
  world,
  type World,
} from "@/test-support/bot-env";

/**
 * El engine desde el bot (`dispatch/engine.ts`): arma la foto de la flota, le
 * pregunta a `POST /evaluar` y, si ya es hora, asigna. El engine (Python) es un
 * servidor aparte: aquí contesta uno de mentiras (`fakeEngine`, y a veces uno
 * que falla); la base, las asignaciones y las evaluaciones guardadas son las de
 * verdad. Sin `TEST_DATABASE_URL` se salta.
 */

type Engine = typeof import("./engine");
let dispatch: Engine;
let savedUrl: string | undefined;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  savedUrl = process.env.ENGINE_URL;
  process.env.ENGINE_URL = "http://engine.test:3003/";
  dispatch = await import("./engine");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  process.env.ENGINE_URL = "http://engine.test:3003/";
});

const evaluationOf = async (tripId: number) => (await db.select().from(schema.engineEvaluations).where(eq(schema.engineEvaluations.tripId, tripId)))[0];
const setting = (key: string, value: unknown) => db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });

describe("engine.ts: asignación automática (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    if (savedUrl === undefined) delete process.env.ENGINE_URL;
    else process.env.ENGINE_URL = savedUrl;
    restoreMocks();
    await closeTestDatabase();
  });

  describe("runEngine()", () => {
    it("asigna el pendiente a la ganadora: viaje en ruta, moto ocupada, ruta guardada y la decisión anotada", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      assert.deepEqual(await dispatch.runEngine(), [trip.id]);

      assert.equal((await getTrip(trip.id)).status, "en_route");
      assert.equal((await getAssignment(trip.id)).courierId, w.courier.id);
      assert.equal((await db.select().from(schema.couriers).where(eq(schema.couriers.id, w.courier.id)))[0].status, "busy");
      const [route] = await db.select().from(schema.courierRoutes);
      assert.deepEqual(route.stops, [{ tipo: "R", pedido: trip.id }, { tipo: "C", pedido: trip.id }]);

      const evaluation = await evaluationOf(trip.id);
      assert.equal(evaluation.status, "decided");
      assert.equal(evaluation.courierId, w.courier.id);
      assert.equal(evaluation.reason, null);
      assert.equal(evaluation.engineVersion, "fake-1");
      assert.equal(evaluation.evaluations, 1);
      assert.ok(evaluation.decidedAt);
      assert.ok(evaluation.request && evaluation.response, "quedan la petición y la respuesta, para explicar la decisión");
    });

    it("le pregunta al engine con la URL configurada (sin la barra final) y con la foto de la flota", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      await dispatch.runEngine();
      assert.equal(engineCalls.length, 1);
      const [request] = engineCalls as unknown as { pedido: { id: number; restaurante: number[]; cliente: number[] }; motos: { id: string; sin_senal: boolean; lat: number }[]; modo: string; demanda: string; tiempos: string }[];
      assert.equal(request.pedido.id, trip.id);
      assert.deepEqual(request.pedido.restaurante, [3.45, -76.53]);
      assert.deepEqual(request.motos.map((m) => [m.id, m.sin_senal]), [[String(w.courier.id), false]]);
      assert.equal(request.demanda, "baja");
      assert.equal(request.modo, "valle");
      assert.equal(request.tiempos, "haversine");
    });

    it("con la demanda alta le pide el modo pico, y con km por calle los tiempos con OSRM", async () => {
      await world({ courier: liveCourier() }).then((w) => pendingTrip(w));
      await db.insert(schema.demandState).values({ id: 1, level: "alta" });
      await setting("routing_config", { porCalle: true });
      await dispatch.runEngine();
      const [request] = engineCalls as unknown as { modo: string; demanda: string; tiempos: string }[];
      assert.deepEqual([request.modo, request.demanda, request.tiempos], ["pico", "alta", "osrm"]);
    });

    it("sin ENGINE_URL no corre: los pedidos esperan y no sale ninguna petición", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      delete process.env.ENGINE_URL;
      assert.deepEqual(await dispatch.runEngine(), []);
      assert.equal(engineCalls.length, 0);
      assert.equal((await getTrip(trip.id)).status, "pending");
      assert.equal(await evaluationOf(trip.id), undefined);
    });

    it("en modo manual no corre: asigna solo la central", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      await setting("engine_config", { mode: "manual" });
      assert.deepEqual(await dispatch.runEngine(), []);
      assert.equal(engineCalls.length, 0);
      assert.equal((await getTrip(trip.id)).status, "pending");
    });

    it("sin pendientes no pregunta nada", async () => {
      await world({ courier: liveCourier() });
      assert.deepEqual(await dispatch.runEngine(), []);
      assert.equal(engineCalls.length, 0);
    });

    it("solo evalúa lo pendiente: lo asignado, entregado o cancelado no", async () => {
      const w = await world({ courier: liveCourier() });
      await assignedTrip(w);
      await pendingTrip(w, { status: "cancelled" });
      await pendingTrip(w, { status: "delivered" });
      assert.deepEqual(await dispatch.runEngine(), []);
      assert.equal(engineCalls.length, 0);
    });

    it("el pendiente más viejo primero, y tras cada asignación relee la flota: la moto ya lleva el anterior", async () => {
      const w = await world({ courier: liveCourier() });
      const newer = await pendingTrip(w, { createdAt: minutesAgo(1) });
      const older = await pendingTrip(w, { createdAt: minutesAgo(10) });
      assert.deepEqual(await dispatch.runEngine(), [older.id, newer.id]);
      assert.deepEqual((engineCalls as unknown as { pedido: { id: number } }[]).map((c) => c.pedido.id), [older.id, newer.id]);
      const second = engineCalls[1] as unknown as { motos: { paradas: { tipo: string; pedido: number }[] }[] };
      assert.deepEqual(second.motos[0].paradas.map((p) => [p.tipo, p.pedido]), [["R", older.id], ["C", older.id]], "la segunda evaluación ya ve la ruta de la primera");
    });

    it("cada evaluación suma al contador del pedido", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w, { readyAt: new Date(Date.now() + 25 * 60_000) });
      await dispatch.runEngine();
      await dispatch.runEngine();
      await dispatch.runEngine();
      assert.equal((await evaluationOf(trip.id)).evaluations, 3);
    });

    describe("por qué un pedido sigue esperando (queda anotado para la central)", () => {
      it("faltan datos: sin hora de listo, sin ubicación de recogida o de entrega; no se le pregunta al engine", async () => {
        const w = await world({ courier: liveCourier() });
        const noReady = await pendingTrip(w, { readyAt: null });
        const noPickup = await pendingTrip(w, { pickupLocation: null });
        const noBoth = await pendingTrip(w, { deliveryLocation: null, readyAt: null });
        assert.deepEqual(await dispatch.runEngine(), []);
        assert.equal(engineCalls.length, 0);
        assert.equal((await evaluationOf(noReady.id)).reason, "Faltan datos: hora de listo");
        assert.equal((await evaluationOf(noPickup.id)).reason, "Faltan datos: ubicación del restaurante");
        assert.equal((await evaluationOf(noBoth.id)).reason, "Faltan datos: ubicación de la entrega, hora de listo");
        for (const t of [noReady, noPickup, noBoth]) assert.equal((await evaluationOf(t.id)).status, "waiting");
      });

      it("todavía no es hora: «Se despacha en N min», sin asignar", async () => {
        const w = await world({ courier: liveCourier() });
        const trip = await pendingTrip(w, { readyAt: new Date(Date.now() + 15 * 60_000) });
        assert.deepEqual(await dispatch.runEngine(), []);
        const evaluation = await evaluationOf(trip.id);
        assert.equal(evaluation.status, "waiting");
        assert.equal(evaluation.reason, "Se despacha en 5 min");
        assert.equal(evaluation.faltanMin, 5);
        assert.ok(evaluation.dispatchAt);
        assert.equal((await getTrip(trip.id)).status, "pending");
      });

      it("sin motos elegibles: dice por qué no lo fue ninguna", async () => {
        const w = await world({ courier: liveCourier({ locationUpdatedAt: minutesAgo(10) }) });
        const trip = await pendingTrip(w);
        assert.deepEqual(await dispatch.runEngine(), []);
        assert.equal((await evaluationOf(trip.id)).reason, "Sin motos elegibles (sin GPS: 1)");
        assert.equal((await getTrip(trip.id)).status, "pending");
      });

      it("sin motos conectadas", async () => {
        const w = await world({ courier: { status: "offline" } });
        const trip = await pendingTrip(w);
        assert.deepEqual(await dispatch.runEngine(), []);
        assert.equal((await evaluationOf(trip.id)).reason, "Sin motos elegibles (no hay motos conectadas)");
      });

      it("traduce los motivos del engine para la central", async () => {
        const w = await world({ courier: liveCourier() });
        const trip = await pendingTrip(w);
        engine.reply((request) => ({
          ...fakeEngine(request),
          ganador: null,
          plan: null,
          motos: [
            { id: "1", elegible: false, motivo: "fuera_radio" },
            { id: "2", elegible: false, motivo: "fuera_radio" },
            { id: "3", elegible: false, motivo: "capacidad" },
            { id: "4", elegible: false, motivo: "algo_nuevo" },
          ],
        }));
        await dispatch.runEngine();
        assert.equal((await evaluationOf(trip.id)).reason, "Sin motos elegibles (lejos: 2, con el cupo lleno: 1, algo_nuevo: 1)");
      });

      it("la moto elegida ya no está disponible (se desconectó mientras se evaluaba)", async () => {
        const w = await world({ courier: liveCourier() });
        const paused = await createCourier({ name: "Luis", status: "paused" });
        const trip = await pendingTrip(w);
        engine.reply((request) => ({ ...fakeEngine(request), ganador: String(paused.id) }));
        assert.deepEqual(await dispatch.runEngine(), []);
        assert.equal((await evaluationOf(trip.id)).reason, "La moto elegida ya no está disponible");
        assert.equal((await getTrip(trip.id)).status, "pending");
        assert.equal((await db.select().from(schema.couriers).where(eq(schema.couriers.id, paused.id)))[0].status, "paused");
      });

      for (const [name, reply, reason] of [
        ["no responde (caída de red)", "network", /^Engine: fetch failed$/],
        ["tarda más del límite", "timeout", /^Engine: The operation was aborted due to timeout$/],
        ["responde un error HTTP", { http: 500, body: { error: "boom" } }, /^Engine: HTTP 500: boom$/],
        ["responde algo que no es JSON", "badjson", /^Engine: /],
      ] as const) {
        it(`el engine ${name}: el pedido sigue esperando con el motivo, y no se lanza`, async () => {
          const w = await world({ courier: liveCourier() });
          const trip = await pendingTrip(w);
          engine.reply(reply);
          assert.deepEqual(await dispatch.runEngine(), []);
          const evaluation = await evaluationOf(trip.id);
          assert.equal(evaluation.status, "waiting");
          assert.match(evaluation.reason ?? "", reason);
          assert.equal(evaluation.evaluations, 1);
          assert.ok(evaluation.request, "queda lo que se le preguntó");
          assert.equal((await getTrip(trip.id)).status, "pending");
        });
      }

      it("cuando el engine se recupera, el pedido que esperaba se asigna", async () => {
        const w = await world({ courier: liveCourier() });
        const trip = await pendingTrip(w);
        engine.reply("network");
        await dispatch.runEngine();
        engine.reply(null);
        assert.deepEqual(await dispatch.runEngine(), [trip.id]);
        const evaluation = await evaluationOf(trip.id);
        assert.deepEqual([evaluation.status, evaluation.reason, evaluation.evaluations], ["decided", null, 2]);
      });

      it("un pedido que falla no frena a los demás", async () => {
        const w = await world({ courier: liveCourier() });
        const bad = await pendingTrip(w, { createdAt: minutesAgo(5) });
        const good = await pendingTrip(w, { createdAt: minutesAgo(1) });
        engine.reply((request) => (request.pedido.id === bad.id ? "network" : fakeEngine(request)));
        assert.deepEqual(await dispatch.runEngine(), [good.id]);
        assert.equal((await getTrip(bad.id)).status, "pending");
        assert.equal((await getTrip(good.id)).status, "en_route");
      });
    });

    describe("la foto de la flota", () => {
      it("solo entran las motos conectadas y activas; las demás no", async () => {
        const w = await world({ courier: liveCourier() });
        const busy = await createCourier({ name: "Ocupada", ...liveCourier({ status: "busy" }) });
        await createCourier({ name: "Pausada", ...liveCourier({ status: "paused" }) });
        await createCourier({ name: "Desconectada", ...liveCourier({ status: "offline" }) });
        await createCourier({ name: "Inactiva", ...liveCourier(), active: false });
        await pendingTrip(w);
        await dispatch.runEngine();
        const ids = (engineCalls[0] as unknown as { motos: { id: string }[] }).motos.map((m) => m.id).sort();
        assert.deepEqual(ids, [String(w.courier.id), String(busy.id)].sort());
      });

      it("con el simulador apagado no entran las motos simuladas", async () => {
        const w = await world({ courier: liveCourier() });
        await createCourier({ name: "Moto sim", ...liveCourier(), simulated: true });
        await pendingTrip(w);
        await dispatch.runEngine();
        assert.deepEqual((engineCalls[0] as unknown as { motos: { id: string }[] }).motos.map((m) => m.id), [String(w.courier.id)]);
      });

      it("una moto sin reporte reciente va marcada sin señal", async () => {
        const w = await world({ courier: liveCourier() });
        const stale = await createCourier({ name: "Vieja", ...liveCourier({ locationUpdatedAt: minutesAgo(5) }) });
        await pendingTrip(w);
        await dispatch.runEngine();
        const motos = (engineCalls[0] as unknown as { motos: { id: string; sin_senal: boolean }[] }).motos;
        assert.equal(motos.find((m) => m.id === String(stale.id))?.sin_senal, true);
        assert.equal(motos.find((m) => m.id === String(w.courier.id))?.sin_senal, false);
      });

      it("lo que la moto ya lleva (su ruta) viaja en la petición, para que el engine lo tenga en cuenta", async () => {
        const w = await world({ courier: liveCourier() });
        const carrying = await assignedTrip(w);
        await pendingTrip(w);
        await dispatch.runEngine();
        const [moto] = (engineCalls[0] as unknown as { motos: { paradas: { tipo: string; pedido: number }[] }[] }).motos;
        assert.deepEqual(moto.paradas.map((p) => [p.tipo, p.pedido]), [["R", carrying.trip.id], ["C", carrying.trip.id]]);
      });
    });
  });

  describe("dispatchTrip(): un pedido recién confirmado", () => {
    it("si ya es hora, lo asigna en el acto y devuelve true", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      assert.equal(await dispatch.dispatchTrip(trip.id), true);
      assert.equal((await getTrip(trip.id)).status, "en_route");
      assert.equal((await evaluationOf(trip.id)).status, "decided");
    });

    it("si todavía no es hora, queda pendiente para el tick", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w, { readyAt: new Date(Date.now() + 30 * 60_000) });
      assert.equal(await dispatch.dispatchTrip(trip.id), false);
      assert.equal((await getTrip(trip.id)).status, "pending");
      assert.match((await evaluationOf(trip.id)).reason ?? "", /^Se despacha en \d+ min$/);
    });

    it("sin ENGINE_URL, en modo manual, o con un pedido que ya no está pendiente o no existe: false y sin preguntar", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      delete process.env.ENGINE_URL;
      assert.equal(await dispatch.dispatchTrip(trip.id), false);
      process.env.ENGINE_URL = "http://engine.test:3003";
      await setting("engine_config", { mode: "manual" });
      assert.equal(await dispatch.dispatchTrip(trip.id), false);
      await setting("engine_config", { mode: "auto" });
      assert.equal(await dispatch.dispatchTrip(99_999), false);
      const taken = await assignedTrip(w);
      assert.equal(await dispatch.dispatchTrip(taken.trip.id), false);
      assert.equal(engineCalls.length, 0);
    });

    it("un engine caído no lo tumba: devuelve false y el pedido sigue pendiente", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      engine.reply("network");
      assert.equal(await dispatch.dispatchTrip(trip.id), false);
      assert.equal((await getTrip(trip.id)).status, "pending");
      assert.match((await evaluationOf(trip.id)).reason ?? "", /^Engine: /);
    });

    it("dos confirmaciones a la vez del mismo pedido: se asigna una sola vez", async () => {
      const w: World = await world({ courier: liveCourier() });
      await createCourier({ name: "Luis", ...liveCourier() });
      const trip = await pendingTrip(w);
      const results = await Promise.all([dispatch.dispatchTrip(trip.id), dispatch.dispatchTrip(trip.id)]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await db.select().from(schema.assignments).where(eq(schema.assignments.tripId, trip.id))).length, 1);
    });
  });

});
