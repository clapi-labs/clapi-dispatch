import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  bot,
  createConversation,
  createCourier,
  createRestaurant,
  createTrip,
  getAssignment,
  getCourier,
  getTrip,
  installMocks,
  minutesAgo,
  params,
  request,
  resetMocks,
  restoreMocks,
  setAssignment,
} from "@/test-support/portal-env";

/**
 * Viajes desde el portal: el tablero (`GET /api/trips`), asignar o pasar a otra
 * moto antes de que recoja (`assign`) y la entrega marcada por la central
 * (`deliver`). Las rutas se llaman tal cual, contra la base de pruebas; el bot,
 * que es quien manda el WhatsApp, es de mentiras y se revisa qué se le pidió
 * (`bot.calls`). La protección con sesión está en `proxy.test.ts`. Sin
 * `TEST_DATABASE_URL` se salta.
 */

type Trips = typeof import("./route");
type Assign = typeof import("./[id]/assign/route");
type Deliver = typeof import("./[id]/deliver/route");
let trips: Trips;
let assign: Assign;
let deliver: Deliver;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  trips = await import("./route");
  assign = await import("./[id]/assign/route");
  deliver = await import("./[id]/deliver/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

const setting = (key: string, value: unknown) => db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });

/** La medianoche de Colombia (UTC−5) de hoy: donde empieza «hoy» para el tablero y el arqueo. */
function bogotaMidnight() {
  const shifted = new Date(Date.now() - 5 * 3600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) + 5 * 3600_000);
}

type Listed = Awaited<ReturnType<typeof import("@/db/queries/trips")["listTrips"]>>[number];
const list = async () => (await (await trips.GET()).json()) as (Omit<Listed, "createdAt"> & { createdAt: string; alertAt: string | null; blockageAt: string | null; dispatchAt: string | null })[];
const post = (path: string, id: number, body: unknown) =>
  path === "assign" ? assign.POST(request("POST", `/api/trips/${id}/assign`, { body }), params({ id })) : deliver.POST(request("POST", `/api/trips/${id}/deliver`, { body }), params({ id }));
const assignTo = (id: number, courierId: number | null) => post("assign", id, { courierId });
const deliverAt = (id: number, place?: unknown) => post("deliver", id, place === undefined ? {} : { place });
const notifications = () => bot.calls.filter((c) => c.path === "/api/internal/notify");

describe("viajes del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("GET /api/trips: el tablero", () => {
    it("trae los pendientes, los abiertos y los que se movieron hoy (hora de Colombia), el más nuevo primero", async () => {
      const pending = await createTrip({ createdAt: minutesAgo(10) });
      const courier = await createCourier({ status: "available" });
      const open = await assignedTrip(courier.id, { createdAt: minutesAgo(5) });
      const deliveredToday = await createTrip({ status: "delivered", createdAt: minutesAgo(1) });
      const body = await list();
      assert.deepEqual(body.map((t) => t.id), [deliveredToday.id, open.id, pending.id]);
    });

    it("deja fuera lo entregado o cancelado antes de hoy, pero un viaje abierto de hace días sigue a la vista", async () => {
      const midnight = bogotaMidnight();
      const old = await createTrip({ status: "delivered" });
      await db.update(schema.trips).set({ updatedAt: new Date(midnight.getTime() - 60_000) }).where(eq(schema.trips.id, old.id));
      const oldCancelled = await createTrip({ status: "cancelled" });
      await db.update(schema.trips).set({ updatedAt: new Date(midnight.getTime() - 3600_000) }).where(eq(schema.trips.id, oldCancelled.id));
      const courier = await createCourier({ status: "available" });
      const stuck = await assignedTrip(courier.id);
      await db.update(schema.trips).set({ createdAt: new Date(Date.now() - 3 * 86400_000), updatedAt: new Date(Date.now() - 3 * 86400_000) }).where(eq(schema.trips.id, stuck.id));
      const ids = (await list()).map((t) => t.id);
      assert.ok(!ids.includes(old.id), "entregado ayer");
      assert.ok(!ids.includes(oldCancelled.id), "cancelado ayer");
      assert.ok(ids.includes(stuck.id), "abierto hace 3 días");
    });

    it("lo que se movió después de la medianoche de Colombia entra, aunque ya sea «mañana» en UTC", async () => {
      const midnight = bogotaMidnight();
      const justAfter = await createTrip({ status: "delivered" });
      await db.update(schema.trips).set({ updatedAt: new Date(midnight.getTime() + 1_000) }).where(eq(schema.trips.id, justAfter.id));
      const justBefore = await createTrip({ status: "delivered" });
      await db.update(schema.trips).set({ updatedAt: new Date(midnight.getTime() - 1_000) }).where(eq(schema.trips.id, justBefore.id));
      const ids = (await list()).map((t) => t.id);
      assert.ok(ids.includes(justAfter.id));
      assert.ok(!ids.includes(justBefore.id));
    });

    it("un viaje con moto trae su nombre, su teléfono y las horas de la asignación; uno pendiente, todo vacío", async () => {
      const courier = await createCourier({ name: "Pedro Gómez", status: "available" });
      const withCourier = await assignedTrip(courier.id);
      const seen = new Date(Date.now() - 120_000);
      await setAssignment(withCourier.id, { seenAt: seen, readAt: seen });
      const pending = await createTrip();
      const byId = Object.fromEntries((await list()).map((t) => [t.id, t]));
      assert.equal(byId[withCourier.id].courierName, "Pedro Gómez");
      assert.equal(byId[withCourier.id].courierId, courier.id);
      assert.equal(byId[withCourier.id].courierPhone, courier.phone);
      assert.equal(byId[withCourier.id].seenAt, seen.toISOString());
      assert.equal(byId[withCourier.id].pickedUpAt, null);
      for (const key of ["courierName", "courierId", "courierPhone", "assignedAt", "seenAt", "pickedUpAt", "deliveredAt", "alertAt", "blockageKind"] as const) {
        assert.equal(byId[pending.id][key], null, key);
      }
    });

    describe("distancia del domicilio", () => {
      const near = { lat: 3.45, lng: -76.53 };
      const far = { lat: 3.46, lng: -76.53 };

      it("los km con que se cotizó, si los hay", async () => {
        const t = await createTrip({ routeKm: 2.7, pickupLocation: near, deliveryLocation: far });
        assert.equal((await list()).find((x) => x.id === t.id)!.distanceKm, 2.7);
      });

      it("en los viajes de antes de guardarlos, la línea recta × 1,3", async () => {
        const t = await createTrip({ routeKm: null, pickupLocation: near, deliveryLocation: far });
        const km = (await list()).find((x) => x.id === t.id)!.distanceKm!;
        assert.ok(Math.abs(km - 1.11 * 1.3) < 0.1, `salió ${km}`);
      });

      it("sin alguna de las dos ubicaciones, nada", async () => {
        const noPickup = await createTrip({ routeKm: null, pickupLocation: null, deliveryLocation: far });
        const noDelivery = await createTrip({ routeKm: null, pickupLocation: near, deliveryLocation: null });
        const byId = Object.fromEntries((await list()).map((t) => [t.id, t]));
        assert.equal(byId[noPickup.id].distanceKm, null);
        assert.equal(byId[noDelivery.id].distanceKm, null);
      });
    });

    describe("por qué un pendiente sigue esperando", () => {
      it("con el engine asignando (auto) se ve el motivo y cuándo se despacha", async () => {
        const t = await createTrip();
        const at = new Date(Date.now() + 5 * 60_000);
        await db.insert(schema.engineEvaluations).values({ tripId: t.id, status: "waiting", reason: "Se despacha en 5 min", dispatchAt: at });
        const row = (await list()).find((x) => x.id === t.id)!;
        assert.equal(row.dispatchNote, "Se despacha en 5 min");
        assert.equal(row.dispatchAt, at.toISOString());
      });

      it("en modo manual no se muestra (el engine no corre)", async () => {
        await setting("engine_config", { mode: "manual" });
        const t = await createTrip();
        await db.insert(schema.engineEvaluations).values({ tripId: t.id, status: "waiting", reason: "Se despacha en 5 min", dispatchAt: new Date() });
        const row = (await list()).find((x) => x.id === t.id)!;
        assert.deepEqual([row.dispatchNote, row.dispatchAt], [null, null]);
      });

      it("un viaje que ya no está pendiente no arrastra el motivo viejo", async () => {
        const courier = await createCourier({ status: "available" });
        const t = await assignedTrip(courier.id);
        await db.insert(schema.engineEvaluations).values({ tripId: t.id, status: "decided", reason: "viejo", dispatchAt: new Date() });
        assert.equal((await list()).find((x) => x.id === t.id)!.dispatchNote, null);
      });
    });

    describe("alertas del tablero", () => {
      it("un viaje asignado que no recoge a tiempo sale con su hora de alerta y su bloqueo", async () => {
        const courier = await createCourier({ status: "available" });
        const t = await assignedTrip(courier.id);
        await setAssignment(t.id, { assignedAt: minutesAgo(12), seenAt: minutesAgo(9) });
        const row = (await list()).find((x) => x.id === t.id)!;
        assert.ok(row.alertAt && new Date(row.alertAt).getTime() < Date.now(), "ya pasó la hora de alerta");
        assert.equal(row.blockageKind, "pickup_late");
        assert.ok(row.blockageAt && new Date(row.blockageAt).getTime() < Date.now());
      });

      it("el cliente que no contesta sale como ese bloqueo", async () => {
        const courier = await createCourier({ status: "available" });
        const t = await assignedTrip(courier.id);
        await setAssignment(t.id, { seenAt: minutesAgo(30), pickedUpAt: minutesAgo(20), customerWaitAt: minutesAgo(1) });
        assert.equal((await list()).find((x) => x.id === t.id)!.blockageKind, "customer_no_answer");
      });

      it("un viaje entregado ya no tiene alerta ni bloqueo", async () => {
        const courier = await createCourier({ status: "available" });
        const t = await assignedTrip(courier.id);
        await setAssignment(t.id, { seenAt: minutesAgo(30), pickedUpAt: minutesAgo(20) });
        await deliverAt(t.id);
        const row = (await list()).find((x) => x.id === t.id)!;
        assert.deepEqual([row.alertAt, row.blockageKind], [null, null]);
      });

      it("el segundo pedido de una moto no se alerta como demora en ir a recogerlo mientras no le toque", async () => {
        const courier = await createCourier({ status: "available" });
        const first = await assignedTrip(courier.id);
        await new Promise((r) => setTimeout(r, 15));
        const second = await assignedTrip(courier.id);
        await setAssignment(first.id, { assignedAt: minutesAgo(30), seenAt: minutesAgo(25) });
        await setAssignment(second.id, { assignedAt: minutesAgo(29) });
        const byId = Object.fromEntries((await list()).map((t) => [t.id, t]));
        assert.ok(byId[first.id].alertAt, "el primero es el que sigue");
        assert.equal(byId[second.id].alertAt, null, "el segundo no, todavía");
      });
    });
  });

  describe("POST /api/trips/:id/assign", () => {
    it("asigna un pendiente a una moto libre: en ruta, la moto ocupada y el bot avisa", async () => {
      const courier = await createCourier({ status: "available" });
      const trip = await createTrip();
      const res = await assignTo(trip.id, courier.id);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal((await getTrip(trip.id)).status, "en_route");
      assert.equal((await getAssignment(trip.id)).courierId, courier.id);
      assert.equal((await getCourier(courier.id)).status, "busy");
      assert.deepEqual(notifications().map((c) => c.body), [{ unassigned: [], assigned: [trip.id] }]);
      assert.equal(notifications()[0].secret, "secreto-interno-de-prueba", "con el secreto interno");
    });

    it("una moto ocupada también puede recibir otro pedido", async () => {
      const courier = await createCourier({ status: "available" });
      await assignedTrip(courier.id);
      const second = await createTrip();
      assert.equal((await assignTo(second.id, courier.id)).status, 200);
      assert.equal((await getAssignment(second.id)).courierId, courier.id);
    });

    it("un viaje que no existe: 404 y no llama al bot", async () => {
      const res = await assignTo(99_999, 1);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "No existe" });
      assert.equal(bot.calls.length, 0);
    });

    describe("pasar a otra moto antes de que recoja", () => {
      it("le quita el viaje a la primera, se lo da a la segunda y avisa a las dos", async () => {
        const first = await createCourier({ name: "Pedro", status: "available" });
        const second = await createCourier({ name: "Luis", status: "available" });
        const trip = await assignedTrip(first.id);
        const res = await assignTo(trip.id, second.id);
        assert.equal(res.status, 200);
        assert.equal((await getAssignment(trip.id)).courierId, second.id);
        assert.equal((await getAssignment(trip.id)).courierName, "Luis");
        assert.equal((await getCourier(first.id)).status, "available", "la primera queda libre");
        assert.equal((await getCourier(second.id)).status, "busy");
        assert.deepEqual(notifications()[0].body, { unassigned: [{ tripId: trip.id, courierId: first.id }], assigned: [trip.id] });
      });

      it("el servicio empieza de cero para la nueva moto (lo que había marcado la anterior se borra)", async () => {
        const first = await createCourier({ status: "available" });
        const second = await createCourier({ status: "available" });
        const trip = await assignedTrip(first.id);
        await setAssignment(trip.id, { readAt: minutesAgo(5), seenAt: minutesAgo(4), seenReminderAt: minutesAgo(3), atPickupAt: minutesAgo(1) });
        await assignTo(trip.id, second.id);
        const a = await getAssignment(trip.id);
        assert.deepEqual([a.readAt, a.seenAt, a.seenReminderAt, a.atPickupAt, a.pickedUpAt], [null, null, null, null, null]);
      });

      it("«Ya lo recogieron»: 409, no cambia nada y no avisa", async () => {
        const first = await createCourier({ status: "available" });
        const second = await createCourier({ status: "available" });
        const trip = await assignedTrip(first.id);
        await setAssignment(trip.id, { pickedUpAt: minutesAgo(1) });
        const res = await assignTo(trip.id, second.id);
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: "Ya lo recogieron" });
        assert.equal((await getAssignment(trip.id)).courierId, first.id);
        assert.equal((await getTrip(trip.id)).status, "en_route");
        assert.equal((await getCourier(second.id)).status, "available");
        assert.equal(bot.calls.length, 0);
      });

      it("«Ya lo recogieron» también si solo se le quiere quitar (courierId nulo)", async () => {
        const first = await createCourier({ status: "available" });
        const trip = await assignedTrip(first.id);
        await setAssignment(trip.id, { pickedUpAt: minutesAgo(1) });
        const res = await assignTo(trip.id, null);
        assert.equal(res.status, 409);
        assert.equal((await getAssignment(trip.id)).courierId, first.id);
      });

      it("un viaje ya entregado no se puede reasignar", async () => {
        const first = await createCourier({ status: "available" });
        const second = await createCourier({ status: "available" });
        const trip = await assignedTrip(first.id);
        await setAssignment(trip.id, { seenAt: minutesAgo(5), pickedUpAt: minutesAgo(2) });
        await deliverAt(trip.id);
        bot.calls.length = 0;
        const res = await assignTo(trip.id, second.id);
        assert.equal(res.status, 409);
        assert.equal(bot.calls.length, 0);
        assert.equal((await getTrip(trip.id)).status, "delivered");
      });

      it("con courierId nulo solo se le quita: vuelve a pendiente, la moto queda libre y el bot avisa", async () => {
        const first = await createCourier({ status: "available" });
        const trip = await assignedTrip(first.id);
        const res = await assignTo(trip.id, null);
        assert.equal(res.status, 200);
        assert.equal((await getTrip(trip.id)).status, "pending");
        assert.equal(await getAssignment(trip.id), undefined);
        assert.equal((await getCourier(first.id)).status, "available");
        assert.deepEqual(notifications()[0].body, { unassigned: [{ tripId: trip.id, courierId: first.id }], assigned: [] });
      });

      it("«Quitar» le devuelve su turno: el contador de entregas de la moto baja", async () => {
        const first = await createCourier({ status: "available" });
        const trip = await assignedTrip(first.id);
        assert.equal((await getCourier(first.id)).deliveriesThisShift, 1);
        await assignTo(trip.id, null);
        assert.equal((await getCourier(first.id)).deliveriesThisShift, 0);
      });
    });

    describe("cuando la moto no está disponible", () => {
      for (const status of ["offline", "paused"] as const) {
        it(`una moto ${status}: 409 «Esa moto ya no está disponible» y el pedido sigue pendiente`, async () => {
          const courier = await createCourier({ status });
          const trip = await createTrip();
          const res = await assignTo(trip.id, courier.id);
          assert.equal(res.status, 409);
          assert.deepEqual(await res.json(), { error: "Esa moto ya no está disponible" });
          assert.equal((await getTrip(trip.id)).status, "pending");
          assert.equal(await getAssignment(trip.id), undefined);
        });
      }

      it("una moto desactivada o que no existe: lo mismo", async () => {
        const gone = await createCourier({ status: "available", active: false });
        const trip = await createTrip();
        assert.equal((await assignTo(trip.id, gone.id)).status, 409);
        assert.equal((await assignTo(trip.id, 99_999)).status, 409);
        assert.equal((await getTrip(trip.id)).status, "pending");
      });

      it("al pasar a otra moto que no está disponible, el pedido ya se le quitó a la primera y queda pendiente (el bot igual avisa a la primera)", async () => {
        const first = await createCourier({ status: "available" });
        const offline = await createCourier({ status: "offline" });
        const trip = await assignedTrip(first.id);
        const res = await assignTo(trip.id, offline.id);
        assert.equal(res.status, 409);
        assert.equal((await getTrip(trip.id)).status, "pending");
        assert.equal((await getCourier(first.id)).status, "available");
        assert.deepEqual(notifications()[0].body, { unassigned: [{ tripId: trip.id, courierId: first.id }], assigned: [] });
      });

      it("dos asignaciones a la vez del mismo pedido: gana una sola", async () => {
        const a = await createCourier({ status: "available" });
        const b = await createCourier({ status: "available" });
        const trip = await createTrip();
        const results = await Promise.all([assignTo(trip.id, a.id), assignTo(trip.id, b.id)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal((await db.select().from(schema.assignments).where(eq(schema.assignments.tripId, trip.id))).length, 1);
      });
    });

    describe("el bot es un aviso, no una condición", () => {
      it("si el bot no responde, la asignación igual se guarda", async () => {
        const courier = await createCourier({ status: "available" });
        const trip = await createTrip();
        bot.reply("network");
        const res = await assignTo(trip.id, courier.id);
        assert.equal(res.status, 200);
        assert.equal((await getTrip(trip.id)).status, "en_route");
      });

      it("si el bot contesta error, también", async () => {
        const courier = await createCourier({ status: "available" });
        const trip = await createTrip();
        bot.reply({ status: 401, body: { error: "no" } });
        assert.equal((await assignTo(trip.id, courier.id)).status, 200);
        assert.equal((await getTrip(trip.id)).status, "en_route");
      });

      it("sin BOT_URL ni INTERNAL_SECRET el cambio se guarda y no sale ningún WhatsApp", async () => {
        const courier = await createCourier({ status: "available" });
        const trip = await createTrip();
        delete process.env.BOT_URL;
        const res = await assignTo(trip.id, courier.id);
        assert.equal(res.status, 200);
        assert.equal((await getTrip(trip.id)).status, "en_route");
        assert.equal(bot.calls.length, 0);
      });

      it("si no hay nada que avisar (asignar a nadie un pendiente), no llama al bot", async () => {
        const trip = await createTrip();
        const res = await assignTo(trip.id, null);
        assert.equal(res.status, 200);
        assert.equal(bot.calls.length, 0);
        assert.equal((await getTrip(trip.id)).status, "pending");
      });
    });

    describe("un cuerpo mal formado no le quita el pedido a nadie", () => {
      for (const [name, raw] of [
        ["que no es JSON", "no es json"],
        ["null", "null"],
        ["una lista", "[]"],
        ["un número", "5"],
        ["un objeto sin courierId", "{}"],
        ["con un courierId que no es número ni null", '{"courierId":"7"}'],
        ["con courierId undefined (otro campo)", '{"driver":3}'],
      ] as const) {
        it(`${name}: 400 «Falta courierId» y el viaje asignado sigue con su moto`, async () => {
          const courier = await createCourier({ status: "available" });
          const trip = await assignedTrip(courier.id);
          const res = await assign.POST(request("POST", `/api/trips/${trip.id}/assign`, { raw }), params({ id: trip.id }));
          assert.equal(res.status, 400);
          assert.match(((await res.json()) as { error: string }).error, /^Falta courierId/);
          assert.equal((await getTrip(trip.id)).status, "en_route");
          assert.equal((await getAssignment(trip.id)).courierId, courier.id);
          assert.equal(bot.calls.length, 0);
        });
      }

      it("con courierId null sí se le quita (es lo que manda «Quitar»)", async () => {
        const courier = await createCourier({ status: "available" });
        const trip = await assignedTrip(courier.id);
        const res = await assign.POST(request("POST", `/api/trips/${trip.id}/assign`, { raw: '{"courierId":null}' }), params({ id: trip.id }));
        assert.equal(res.status, 200);
        assert.equal((await getTrip(trip.id)).status, "pending");
      });
    });
  });

  describe("POST /api/trips/:id/deliver", () => {
    async function onTheWay() {
      const courier = await createCourier({ status: "available" });
      const conversation = await createConversation();
      const restaurant = await createRestaurant();
      const trip = await assignedTrip(courier.id, { conversationId: conversation.id, restaurantId: restaurant.id });
      await setAssignment(trip.id, { seenAt: minutesAgo(10), pickedUpAt: minutesAgo(5) });
      return { courier, trip };
    }

    it("en el cliente: entregado, con la hora y el lugar, la moto libre y el bot avisa", async () => {
      const { courier, trip } = await onTheWay();
      const res = await deliverAt(trip.id, "customer");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal((await getTrip(trip.id)).status, "delivered");
      const a = await getAssignment(trip.id);
      assert.equal(a.deliveryPlace, "customer");
      assert.ok(a.deliveredAt && a.finishedAt);
      assert.equal((await getCourier(courier.id)).status, "available");
      assert.deepEqual(notifications().map((c) => c.body), [{ delivered: [trip.id] }]);
    });

    it("en portería: queda anotado como portería", async () => {
      const { trip } = await onTheWay();
      assert.equal((await deliverAt(trip.id, "gate")).status, 200);
      assert.equal((await getAssignment(trip.id)).deliveryPlace, "gate");
    });

    it("sin lugar, o con uno que no existe, cuenta como entrega al cliente", async () => {
      for (const place of [undefined, "casa", 5, null, "GATE"]) {
        const { trip } = await onTheWay();
        assert.equal((await deliverAt(trip.id, place)).status, 200);
        assert.equal((await getAssignment(trip.id)).deliveryPlace, "customer", String(place));
      }
    });

    it("un cuerpo que no es JSON (o es null) también entrega al cliente", async () => {
      const { trip } = await onTheWay();
      const res = await deliver.POST(request("POST", `/api/trips/${trip.id}/deliver`, { raw: "no es json" }), params({ id: trip.id }));
      assert.equal(res.status, 200);
      assert.equal((await getAssignment(trip.id)).deliveryPlace, "customer");
    });

    it("un doble toque (o la entrega que ya marcó el motorizado): 409 y no cambia nada ni avisa otra vez", async () => {
      const { trip } = await onTheWay();
      await deliverAt(trip.id, "customer");
      const delivered = (await getAssignment(trip.id)).deliveredAt;
      bot.calls.length = 0;
      const res = await deliverAt(trip.id, "gate");
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { ok: false });
      assert.equal((await getAssignment(trip.id)).deliveryPlace, "customer", "no cambia el lugar");
      assert.equal((await getAssignment(trip.id)).deliveredAt?.getTime(), delivered?.getTime());
      assert.equal(bot.calls.length, 0);
    });

    it("un viaje pendiente (sin moto) o que no existe no se puede entregar: 409", async () => {
      const pending = await createTrip();
      assert.equal((await deliverAt(pending.id)).status, 409);
      assert.equal((await getTrip(pending.id)).status, "pending");
      assert.equal((await deliverAt(99_999)).status, 409);
      assert.equal(bot.calls.length, 0);
    });

    it("un viaje cancelado no se entrega", async () => {
      const trip = await createTrip({ status: "cancelled" });
      assert.equal((await deliverAt(trip.id)).status, 409);
      assert.equal((await getTrip(trip.id)).status, "cancelled");
    });

    it("la moto con otro pedido encima sigue ocupada", async () => {
      const { courier, trip } = await onTheWay();
      await assignedTrip(courier.id);
      await deliverAt(trip.id);
      assert.equal((await getCourier(courier.id)).status, "busy");
    });

    it("si el bot no responde, la entrega igual queda guardada", async () => {
      const { trip } = await onTheWay();
      bot.reply("network");
      assert.equal((await deliverAt(trip.id)).status, 200);
      assert.equal((await getTrip(trip.id)).status, "delivered");
    });

    it("un datáfono declarado con ese pedido no deja ocupada a la moto (es un pendiente aparte)", async () => {
      const { courier, trip } = await onTheWay();
      await db.insert(schema.returnDebts).values({ courierId: courier.id, tripId: trip.id, reason: "datafono", restaurantName: "Resto", declaredBy: "courier" });
      await deliverAt(trip.id);
      assert.equal((await getCourier(courier.id)).status, "available");
    });
  });
});
