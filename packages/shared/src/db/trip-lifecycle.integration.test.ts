import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import * as client from "./client";
import * as config from "./engine-config";
import * as schema from "./schema";
import { closeTestDatabase, createConversation, createCourier, createTrip, integrationSkip, resetDatabase } from "./test-db";
import * as life from "./trip-lifecycle";

/**
 * Pruebas contra un Postgres de verdad, para el ciclo de vida del viaje y la
 * configuración del engine. Usan la base de `TEST_DATABASE_URL` (ya migrada, de
 * usar y tirar: se vacía entera; ver `test-db.ts`); sin ella se saltan, y en CI
 * (`REQUIRE_TEST_DATABASE=1`) fallan en vez de saltarse. Para correrlas en
 * local: `docs/OPERACION.md`, «Pruebas de integración».
 */
describe("ciclo de vida del viaje (Postgres)", { skip: integrationSkip }, () => {
  let conversationId: number;

  after(closeTestDatabase);

  beforeEach(async () => {
    await resetDatabase();
    conversationId = (await createConversation({ phone: "573000000000" })).id;
  });

  const courier = (status: "available" | "busy" | "offline" | "paused" = "available", name = "Moto") => createCourier({ name, status });
  const trip = (status: "pending" | "assigned" | "en_route" = "pending") => createTrip({ status, conversationId });

  const tripStatus = async (id: number) => (await client.db.query.trips.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!.status;
  const courierRow = async (id: number) => (await client.db.query.couriers.findFirst({ where: (c, { eq }) => eq(c.id, id) }))!;
  const assignmentOf = async (tripId: number) => client.db.query.assignments.findFirst({ where: (a, { eq }) => eq(a.tripId, tripId) });

  describe("assignTripTo", () => {
    it("asigna el viaje pendiente a una moto libre y la deja ocupada", async () => {
      const [c, t] = [await courier(), await trip()];
      assert.deepEqual(await life.assignTripTo(t.id, c.id), { courierId: c.id, courierName: "Moto" });
      assert.equal(await tripStatus(t.id), "en_route");
      assert.equal((await courierRow(c.id)).status, "busy");
      assert.equal((await courierRow(c.id)).deliveriesThisShift, 1);
      assert.equal((await assignmentOf(t.id))?.courierId, c.id);
    });

    it("una moto ocupada también puede recibir otro pedido (multipedido)", async () => {
      const c = await courier("busy");
      const t = await trip();
      assert.ok(await life.assignTripTo(t.id, c.id));
      assert.equal(await tripStatus(t.id), "en_route");
    });

    it("un viaje que ya no está pendiente no se asigna dos veces", async () => {
      const [a, b, t] = [await courier(), await courier(), await trip()];
      assert.ok(await life.assignTripTo(t.id, a.id));
      assert.equal(await life.assignTripTo(t.id, b.id), null);
      assert.equal((await assignmentOf(t.id))?.courierId, a.id);
      assert.equal((await courierRow(b.id)).status, "available");
    });

    it("dos asignaciones a la vez: gana una sola", async () => {
      const [a, b, t] = [await courier(), await courier(), await trip()];
      const results = await Promise.all([life.assignTripTo(t.id, a.id), life.assignTripTo(t.id, b.id)]);
      assert.equal(results.filter(Boolean).length, 1);
      const busy = (await Promise.all([courierRow(a.id), courierRow(b.id)])).filter((r) => r.status === "busy");
      assert.equal(busy.length, 1);
    });

    for (const status of ["offline", "paused"] as const) {
      it(`si la moto está ${status}, el viaje sigue pendiente`, async () => {
        const [c, t] = [await courier(status), await trip()];
        assert.equal(await life.assignTripTo(t.id, c.id), null);
        assert.equal(await tripStatus(t.id), "pending");
        assert.equal(await assignmentOf(t.id), undefined);
      });
    }

    it("una moto desactivada no recibe viajes", async () => {
      const [c, t] = [await courier(), await trip()];
      await client.db.update(schema.couriers).set({ active: false }).where(eq(schema.couriers.id, c.id));
      assert.equal(await life.assignTripTo(t.id, c.id), null);
      assert.equal(await tripStatus(t.id), "pending");
    });
  });

  describe("returnTripToDispatch", () => {
    it("antes de recoger: el viaje vuelve a pendiente y la moto queda libre", async () => {
      const [c, t] = [await courier(), await trip()];
      await life.assignTripTo(t.id, c.id);
      await client.db.insert(schema.engineEvaluations).values({ tripId: t.id, status: "decided" });
      assert.deepEqual(await life.returnTripToDispatch(t.id), { courierId: c.id });
      assert.equal(await tripStatus(t.id), "pending");
      assert.equal(await assignmentOf(t.id), undefined);
      const after = await courierRow(c.id);
      assert.equal(after.status, "available");
      assert.equal(after.deliveriesThisShift, 0);
      // La decisión del engine ya no vale: que evalúe de nuevo.
      assert.equal((await client.db.select().from(schema.engineEvaluations)).length, 0);
    });

    it("con el pedido ya recogido no se puede devolver", async () => {
      const [c, t] = [await courier(), await trip()];
      await life.assignTripTo(t.id, c.id);
      await client.db.update(schema.assignments).set({ pickedUpAt: new Date() }).where(eq(schema.assignments.tripId, t.id));
      assert.equal(await life.returnTripToDispatch(t.id), null);
      assert.equal(await tripStatus(t.id), "en_route");
    });

    it("si la moto lleva otro pedido, sigue ocupada", async () => {
      const c = await courier();
      const [t1, t2] = [await trip(), await trip()];
      await life.assignTripTo(t1.id, c.id);
      await life.assignTripTo(t2.id, c.id);
      await life.returnTripToDispatch(t2.id);
      assert.equal((await courierRow(c.id)).status, "busy");
      assert.equal((await courierRow(c.id)).deliveriesThisShift, 1);
    });
  });

  describe("returnUnpickedTrips", () => {
    it("devuelve lo que no ha recogido y deja lo que ya lleva", async () => {
      const c = await courier();
      const [picked, waiting] = [await trip(), await trip()];
      await life.assignTripTo(picked.id, c.id);
      await life.assignTripTo(waiting.id, c.id);
      await client.db.update(schema.assignments).set({ pickedUpAt: new Date() }).where(eq(schema.assignments.tripId, picked.id));
      assert.deepEqual(await life.returnUnpickedTrips(c.id), [waiting.id]);
      assert.equal(await tripStatus(waiting.id), "pending");
      assert.equal(await tripStatus(picked.id), "en_route");
      assert.equal((await courierRow(c.id)).status, "busy");
    });
  });

  describe("deliverTrip", () => {
    it("entrega, guarda hora y lugar, y deja libre a la moto", async () => {
      const [c, t] = [await courier(), await trip()];
      await life.assignTripTo(t.id, c.id);
      assert.equal(await life.deliverTrip(t.id, { place: "gate" }), true);
      assert.equal(await tripStatus(t.id), "delivered");
      const a = await assignmentOf(t.id);
      assert.equal(a?.deliveryPlace, "gate");
      assert.ok(a?.deliveredAt && a.finishedAt);
      assert.equal((await courierRow(c.id)).status, "available");
    });

    it("ya no asigna pendientes: eso lo hace el engine en el siguiente tick", async () => {
      const [c, t] = [await courier(), await trip()];
      const waiting = await trip();
      await life.assignTripTo(t.id, c.id);
      await life.deliverTrip(t.id, { place: "customer" });
      assert.equal(await tripStatus(waiting.id), "pending");
      assert.equal(await assignmentOf(waiting.id), undefined);
      assert.equal((await courierRow(c.id)).status, "available");
    });

    it("si la moto lleva otro pedido, sigue ocupada", async () => {
      const c = await courier();
      const [t1, t2] = [await trip(), await trip()];
      await life.assignTripTo(t1.id, c.id);
      await life.assignTripTo(t2.id, c.id);
      await life.deliverTrip(t1.id, { place: "customer" });
      assert.equal((await courierRow(c.id)).status, "busy");
    });

    it("un doble toque devuelve false y no cambia nada", async () => {
      const [c, t] = [await courier(), await trip()];
      await life.assignTripTo(t.id, c.id);
      assert.equal(await life.deliverTrip(t.id, { place: "customer" }), true);
      assert.equal(await life.deliverTrip(t.id, { place: "gate" }), false);
      assert.equal((await assignmentOf(t.id))?.deliveryPlace, "customer");
    });

    it("un viaje pendiente no se puede entregar", async () => {
      const t = await trip();
      assert.equal(await life.deliverTrip(t.id, { place: "customer" }), false);
      assert.equal(await tripStatus(t.id), "pending");
    });
  });

  describe("closeUndeliveredTrip", () => {
    it("cancela el viaje y libera a la moto", async () => {
      const [c, t] = [await courier(), await trip()];
      await life.assignTripTo(t.id, c.id);
      assert.equal(await life.closeUndeliveredTrip(t.id), true);
      assert.equal(await tripStatus(t.id), "cancelled");
      assert.ok((await assignmentOf(t.id))?.finishedAt);
      assert.equal((await courierRow(c.id)).status, "available");
      assert.equal(await life.closeUndeliveredTrip(t.id), false);
    });
  });

  describe("saveCourierRoute", () => {
    it("guarda el orden de paradas y lo reemplaza en la siguiente", async () => {
      const c = await courier();
      await life.saveCourierRoute(c.id, [{ tipo: "R", pedido: 1 }]);
      await life.saveCourierRoute(c.id, [{ tipo: "R", pedido: 2 }, { tipo: "C", pedido: 2 }]);
      const [row] = await client.db.select().from(schema.courierRoutes);
      assert.equal((row.stops as unknown[]).length, 2);
    });
  });

  describe("getEngineConfig con lo que haya en settings", () => {
    const save = (value: unknown) => client.db.insert(schema.settings).values({ key: config.ENGINE_CONFIG_KEY, value });

    it("una base sin engine_config asigna con el engine", async () => {
      assert.deepEqual(await config.getEngineConfig(), config.DEFAULT_ENGINE_CONFIG);
      assert.equal((await config.getEngineConfig()).mode, "auto");
    });

    for (const mode of ["shadow", "queue"]) {
      it(`una fila vieja con «${mode}» se lee como auto y conserva sus ajustes`, async () => {
        await save({ mode, radioKm: 6, multipedido: false });
        assert.deepEqual(await config.getEngineConfig(), { mode: "auto", radioKm: 6, multipedido: false });
      });
    }

    it("manual se respeta", async () => {
      await save({ mode: "manual" });
      assert.equal((await config.getEngineConfig()).mode, "manual");
    });
  });
});
