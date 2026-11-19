import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, getSimulatorConfig, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import { assignedTrip, bot, createCourier, createRestaurant, getCourier, getTrip, installMocks, request, resetMocks, restoreMocks, setAssignment, minutesAgo } from "@/test-support/portal-env";

/**
 * El simulador de staging (`/api/simulador`), y con él lo más parecido a «crear
 * un viaje a mano» que tiene el portal: la acción `order`, que le pide al bot
 * un pedido de prueba por el mismo camino que uno de WhatsApp. (El portal no
 * tiene un `POST /api/trips`: los viajes los crea el bot.) Sin
 * `SIMULATOR_ENABLED` la ruta no existe. Las rutas se llaman tal cual, contra la
 * base de pruebas; el bot es de mentiras. Sin `TEST_DATABASE_URL` se salta.
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
  process.env.SIMULATOR_ENABLED = "1";
});

const post = (body: unknown) => route.POST(request("POST", "/api/simulador", { body }));
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("simulador del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    delete process.env.SIMULATOR_ENABLED;
    restoreMocks();
    await closeTestDatabase();
  });

  it("sin SIMULATOR_ENABLED la ruta no existe: 404 en GET y POST, y no hace nada", async () => {
    delete process.env.SIMULATOR_ENABLED;
    const res = await post({ action: "add" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No encontrado" });
    assert.equal((await route.GET()).status, 404);
    assert.equal((await db.select().from(schema.couriers)).length, 0);
  });

  describe("«crear un viaje»: la acción order", () => {
    it("le pide al bot un pedido de prueba desde un restaurante, con el secreto interno", async () => {
      const restaurant = await createRestaurant({ name: "Pizza Nona", knownPickupLocation: { lat: 3.45, lng: -76.53 } });
      const res = await post({ action: "order", restaurantId: restaurant.id, lat: 3.46, lng: -76.52, readyInMinutes: 10 });
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(bot.calls.map((c) => [c.path, c.body, c.secret]), [["/api/internal/simulator", { action: "order", restaurantId: restaurant.id, lat: 3.46, lng: -76.52, readyInMinutes: 10, courierId: null }, "secreto-interno-de-prueba"]]);
    });

    it("sin minutos de espera el pedido sale ya listo (0); lo que no es número se pasa como nulo", async () => {
      await post({ action: "order", restaurantId: "1", lat: "3.46", lng: null });
      assert.deepEqual(bot.calls[0].body, { action: "order", restaurantId: null, lat: null, lng: null, readyInMinutes: 0, courierId: null });
    });

    it("un viaje de prueba para una moto real con GPS lleva su id", async () => {
      await post({ action: "order", restaurantId: 1, lat: 3.46, lng: -76.52, courierId: 7 });
      assert.equal((bot.calls[0].body as { courierId: number }).courierId, 7);
    });

    it("si el bot da un motivo (moto no conectada…), se le muestra a la central tal cual: 502", async () => {
      bot.reply({ status: 409, body: { reason: "Esa moto no está conectada" } });
      const res = await post({ action: "order", restaurantId: 1, lat: 3.46, lng: -76.52 });
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: "Esa moto no está conectada" });
    });

    it("si el fallo es técnico (bot caído, secreto malo, error HTTP), se dice que el bot no creó el pedido", async () => {
      for (const [reply, expected] of [
        [{ status: 500, body: {} }, "El bot no creó el pedido (http_500)"],
        [{ status: 401, body: {} }, "El bot no creó el pedido (bad_secret)"],
      ] as const) {
        bot.reply(reply);
        const res = await post({ action: "order", restaurantId: 1, lat: 3.46, lng: -76.52 });
        assert.equal(res.status, 502);
        assert.deepEqual(await res.json(), { error: expected });
      }
      bot.reply("network");
      const down = await post({ action: "order", restaurantId: 1, lat: 3.46, lng: -76.52 });
      assert.equal(down.status, 502);
      assert.match(((await down.json()) as { error: string }).error, /^El bot no creó el pedido/);
      delete process.env.BOT_URL;
      assert.deepEqual(await (await post({ action: "order", restaurantId: 1, lat: 3.46, lng: -76.52 })).json(), { error: "El bot no creó el pedido (no_bot)" });
    });
  });

  describe("las motos simuladas", () => {
    it("«add» crea una moto simulada disponible, en el punto pedido o cerca de la base", async () => {
      const at = await json(await post({ action: "add", lat: 3.45, lng: -76.53 }));
      const placed = await getCourier(at.id as number);
      assert.deepEqual([placed.simulated, placed.status, placed.lat, placed.lng], [true, "available", 3.45, -76.53]);
      const random = await json(await post({ action: "add" }));
      const other = await getCourier(random.id as number);
      assert.ok(other.simulated && other.lat !== null && other.lng !== null);
      assert.notEqual(other.id, placed.id);
    });

    it("«connect» y «disconnect» solo valen para motos simuladas", async () => {
      const real = await createCourier({ status: "available" });
      for (const action of ["connect", "disconnect"]) {
        const res = await post({ action, courierId: real.id });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "No es una moto simulada" });
      }
      assert.equal((await getCourier(real.id)).status, "available");
      assert.equal((await post({ action: "connect" })).status, 400);
    });

    it("desconectar una simulada devuelve lo que no ha recogido y le avisa al bot", async () => {
      const sim = await createCourier({ status: "available", simulated: true });
      const waiting = await assignedTrip(sim.id);
      const res = await post({ action: "disconnect", courierId: sim.id });
      assert.equal(res.status, 200);
      assert.equal((await getCourier(sim.id)).status, "offline");
      assert.equal((await getTrip(waiting.id)).status, "pending");
      assert.deepEqual(bot.calls.map((c) => c.body), [{ unassigned: [{ tripId: waiting.id, courierId: sim.id }] }]);
      assert.equal((await post({ action: "connect", courierId: sim.id })).status, 200);
      assert.equal((await getCourier(sim.id)).status, "available");
    });

    it("la que ya recogió se queda con su pedido al desconectarse", async () => {
      const sim = await createCourier({ status: "available", simulated: true });
      const carrying = await assignedTrip(sim.id);
      await setAssignment(carrying.id, { seenAt: minutesAgo(5), pickedUpAt: minutesAgo(2) });
      await post({ action: "disconnect", courierId: sim.id });
      assert.equal((await getTrip(carrying.id)).status, "en_route");
      assert.equal(bot.calls.length, 0);
    });

    it("«park» y «release» fijan y sueltan una moto en un punto", async () => {
      const sim = await createCourier({ status: "available", simulated: true });
      assert.equal((await post({ action: "park", courierId: sim.id, lat: 3.4, lng: -76.5 })).status, 200);
      assert.deepEqual((await getSimulatorConfig()).parked[String(sim.id)], { lat: 3.4, lng: -76.5 });
      assert.equal((await post({ action: "release", courierId: sim.id })).status, 200);
      assert.equal((await getSimulatorConfig()).parked[String(sim.id)], undefined);
    });

    it("«park» pide moto simulada y un punto; «release» pide la moto", async () => {
      const real = await createCourier({ status: "available" });
      const sim = await createCourier({ status: "available", simulated: true });
      for (const body of [{ action: "park", courierId: real.id, lat: 3.4, lng: -76.5 }, { action: "park", courierId: sim.id }, { action: "park", courierId: sim.id, lat: "3.4", lng: -76.5 }, { action: "release" }]) {
        const res = await post(body);
        assert.equal(res.status, 400, JSON.stringify(body));
      }
    });

    it("«reset» borra las motos simuladas y sus pedidos, y deja las reales", async () => {
      const real = await createCourier({ status: "available" });
      const sim = await createCourier({ status: "available", simulated: true });
      const trip = await assignedTrip(sim.id);
      const res = await post({ action: "reset" });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { ok: boolean }).ok, true);
      assert.equal((await db.select().from(schema.trips).where(eq(schema.trips.id, trip.id))).length, 0);
      assert.ok(await getCourier(real.id));
      assert.equal((await db.select().from(schema.couriers).where(eq(schema.couriers.id, sim.id))).length, 0);
    });
  });

  describe("los ajustes del simulador (validaciones)", () => {
    for (const [action, valid, bad] of [
      ["speed", { value: 10 }, [{ value: 0 }, { value: 51 }, { value: "10" }, {}]],
      ["radius", { value: 5 }, [{ value: 0 }, { value: -1 }, { value: 31 }, { value: null }]],
    ] as const) {
      it(`${action}: acepta un valor dentro del rango y rechaza lo demás con 400`, async () => {
        assert.equal((await post({ action, ...valid })).status, 200);
        for (const body of bad) assert.equal((await post({ action, ...body })).status, 400, JSON.stringify(body));
      });
    }

    it("la velocidad y los porcentajes quedan guardados", async () => {
      await post({ action: "speed", value: 12 });
      await post({ action: "outcomes", gatePercent: 30, returnPercent: 20, noAnswerPercent: 10 });
      const config = await getSimulatorConfig();
      assert.deepEqual([config.speed, config.gatePercent, config.returnPercent, config.noAnswerPercent], [12, 30, 20, 10]);
    });

    it("los porcentajes van de 0 a 100, los tres", async () => {
      assert.equal((await post({ action: "outcomes", gatePercent: 0, returnPercent: 100, noAnswerPercent: 50 })).status, 200);
      for (const body of [{ gatePercent: 101, returnPercent: 0, noAnswerPercent: 0 }, { gatePercent: -1, returnPercent: 0, noAnswerPercent: 0 }, { gatePercent: 0, returnPercent: 0 }, { gatePercent: "5", returnPercent: 0, noAnswerPercent: 0 }]) {
        const res = await post({ action: "outcomes", ...body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.deepEqual(await res.json(), { error: "Porcentajes entre 0 y 100" });
      }
    });

    it("una acción que no existe, o un cuerpo que no es JSON: 400", async () => {
      const unknown = await post({ action: "volar" });
      assert.equal(unknown.status, 400);
      assert.deepEqual(await unknown.json(), { error: "Acción desconocida" });
      assert.equal((await route.POST(request("POST", "/api/simulador", { raw: "no es json" }))).status, 400);
    });
  });
});
