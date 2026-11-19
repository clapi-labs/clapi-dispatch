import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { eq } from "drizzle-orm";

import { db, getSimulatorConfig, saveFareRanges, schema, createServiceZone } from "@dispatch/shared/db";
import { closeTestDatabase, createCourier, createRestaurant, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

/**
 * El «viaje a mano» de la central: un pedido creado desde el mapa del
 * simulador, sin WhatsApp (`createSimulatedOrder` y su ruta
 * `/api/internal/simulator`). El portal solo le pide al bot que lo cree
 * (`apps/portal/.../simulador.test.ts`); aquí se prueba que de verdad se cree:
 * se cotiza con la tabla por km y las zonas, se guarda con su precio congelado,
 * y se despacha o se le asigna a una moto real con GPS (el viaje de prueba).
 * Contra la base de pruebas, con WhatsApp simulado. Sin `TEST_DATABASE_URL` se
 * salta.
 */

type Order = typeof import("./order");
type Route = typeof import("@/app/api/internal/simulator/route");
let order: Order;
let route: Route;
const sent: { phone: string; text: string }[] = [];
const saved: Record<string, string | undefined> = {};
const SECRET = "secreto-interno-de-prueba";

before(async () => {
  if (integrationSkip) return;
  for (const key of ["ENGINE_URL", "INTERNAL_SECRET", "SIMULATOR_ENABLED"]) saved[key] = process.env[key];
  const client = await import("@/services/whatsapp/client");
  const record = async (phone: string, text: string) => {
    sent.push({ phone, text });
    return { ok: true as const, messageId: `wamid.out.${sent.length}` };
  };
  mock.module("@/services/whatsapp/client", {
    namedExports: { ...client, sendText: record, sendButtons: record, sendList: record, markRead: async () => {}, markReadAndTyping: async () => {} },
  });
  order = await import("./order");
  route = await import("@/app/api/internal/simulator/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  sent.length = 0;
  delete process.env.ENGINE_URL; // sin engine: el pedido queda pendiente y lo toma el tick
  process.env.INTERNAL_SECRET = SECRET;
  process.env.SIMULATOR_ENABLED = "1";
  await saveFareRanges([
    { upToKm: 3, price: 5_000 },
    { upToKm: null, price: 8_000 },
  ]);
});

const PICKUP = { lat: 3.45, lng: -76.53 };
/** ~1,4 km por calle de la recogida: la primera banda de la tabla. */
const NEAR = { lat: 3.46, lng: -76.53 };
const restaurant = () => createRestaurant({ name: "Pizza Nona", knownPickupAddress: "Calle 5 # 38-10", knownPickupLocation: PICKUP });
const trips = () => db.select().from(schema.trips);
/** Una moto real con GPS: la única a la que la central le puede mandar un viaje de prueba. */
async function realGpsCourier(status: "available" | "offline" = "available") {
  const courier = await createCourier({ name: "Pedro Gómez", status });
  await db.insert(schema.courierProfiles).values({ courierId: courier.id, gpsDeviceId: `moto-${courier.id}-abc` });
  return courier;
}

describe("pedido de prueba desde el mapa del simulador (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    mock.restoreAll();
    await closeTestDatabase();
  });

  describe("createSimulatedOrder()", () => {
    it("crea el viaje con la dirección del punto, el precio de la tabla congelado y sin chat al que avisarle", async () => {
      const r = await restaurant();
      const result = await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0 });
      assert.ok("tripId" in result);
      const [trip] = await trips();
      assert.equal(trip.id, result.tripId);
      assert.match(trip.code, /^[A-Z]-\d{2}$/);
      assert.equal(result.code, trip.code);
      assert.deepEqual(
        [trip.status, trip.conversationId, trip.restaurantId, trip.originRestaurantName, trip.pickupAddress, trip.customerName, trip.deliveryFee],
        ["pending", null, r.id, "Pizza Nona", "Calle 5 # 38-10", "Cliente simulado", 5_000],
      );
      assert.equal(trip.deliveryAddress, "Punto del simulador (3.46000, -76.53000)");
      assert.deepEqual(trip.deliveryLocation, NEAR);
      assert.deepEqual(trip.pickupLocation, PICKUP);
      assert.ok(trip.routeKm && trip.routeKm > 1 && trip.routeKm < 2, `km ${trip.routeKm}`);
      assert.equal(trip.fareTablePrice, 5_000);
      assert.equal(sent.length, 0, "sin engine ni moto, no sale ningún WhatsApp");
    });

    it("la comida lista en N minutos (hora exacta)", async () => {
      const r = await restaurant();
      const before = Date.now();
      await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 15 });
      const [trip] = await trips();
      const ready = trip.readyAt!.getTime();
      assert.ok(ready >= before + 15 * 60_000 && ready <= Date.now() + 15 * 60_000, "dentro de 15 minutos");
    });

    it("el precio sale de la tabla y del ajuste de la zona", async () => {
      const r = await restaurant();
      await createServiceZone({
        name: "Ciudad Jardín",
        ring: [
          { lat: 3.44, lng: -76.54 },
          { lat: 3.44, lng: -76.52 },
          { lat: 3.47, lng: -76.52 },
          { lat: 3.47, lng: -76.54 },
        ],
        barrioCode: null,
        fareAdjustment: 1_500,
      });
      await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0 });
      const [trip] = await trips();
      assert.deepEqual([trip.deliveryFee, trip.fareTablePrice, trip.fareAdjustment, trip.fareZoneName], [6_500, 5_000, 1_500, "Ciudad Jardín"]);
    });

    it("queda anotado en el simulador (para borrarlo al reiniciar)", async () => {
      const r = await restaurant();
      const first = await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0 });
      const second = await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0 });
      assert.ok("tripId" in first && "tripId" in second);
      assert.deepEqual((await getSimulatorConfig()).trips, [(first as { tripId: number }).tripId, (second as { tripId: number }).tripId]);
    });

    it("un restaurante que no existe o sin ubicación de recogida: no se crea nada", async () => {
      assert.deepEqual(await order.createSimulatedOrder({ restaurantId: 99_999, ...NEAR, readyInMinutes: 0 }), { error: "Ese restaurante no tiene ubicación" });
      const lost = await createRestaurant({ name: "Sin ubicación", knownPickupLocation: null });
      assert.deepEqual(await order.createSimulatedOrder({ restaurantId: lost.id, ...NEAR, readyInMinutes: 0 }), { error: "Ese restaurante no tiene ubicación" });
      assert.equal((await trips()).length, 0);
    });

    it("con la tabla de tarifas vacía no se puede cotizar", async () => {
      const r = await restaurant();
      await db.delete(schema.settings);
      const result = await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0 });
      assert.deepEqual(result, { error: "La tabla de tarifas por km está vacía: no se puede cotizar." });
      assert.equal((await trips()).length, 0);
    });

    it("un punto fuera de las zonas de servicio no se cotiza ni se crea", async () => {
      const r = await restaurant();
      await createServiceZone({
        name: "Ciudad Jardín",
        ring: [
          { lat: 3.44, lng: -76.54 },
          { lat: 3.44, lng: -76.52 },
          { lat: 3.47, lng: -76.52 },
          { lat: 3.47, lng: -76.54 },
        ],
        barrioCode: null,
        fareAdjustment: 0,
      });
      const result = await order.createSimulatedOrder({ restaurantId: r.id, lat: 3.7, lng: -76.53, readyInMinutes: 0 });
      assert.deepEqual(result, { error: "Ese punto queda fuera de las zonas de servicio o del mapa de calles: no se puede cotizar." });
      assert.equal((await trips()).length, 0);
    });

    describe("el viaje de prueba de una moto real con GPS", () => {
      it("se le asigna a ella (como si lo hiciera la central), queda ocupada y recibe el mensaje 1 en su WhatsApp", async () => {
        const r = await restaurant();
        const courier = await realGpsCourier();
        const result = await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0, courierId: courier.id });
        assert.ok("tripId" in result);
        const [trip] = await trips();
        assert.equal(trip.status, "en_route");
        const [assignment] = await db.select().from(schema.assignments).where(eq(schema.assignments.tripId, trip.id));
        assert.equal(assignment.courierId, courier.id);
        assert.equal((await db.select().from(schema.couriers).where(eq(schema.couriers.id, courier.id)))[0].status, "busy");
        assert.equal(sent.length, 1);
        assert.equal(sent[0].phone, courier.phone);
        assert.match(sent[0].text, new RegExp(`nuevo pedido ${trip.code}`));
      });

      it("una moto sin GPS (o que no existe) no vale: «No es una moto real con GPS» y no se crea nada", async () => {
        const r = await restaurant();
        const noGps = await createCourier({ status: "available" });
        for (const courierId of [noGps.id, 99_999]) {
          assert.deepEqual(await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0, courierId }), { error: "No es una moto real con GPS" });
        }
        assert.equal((await trips()).length, 0);
      });

      it("una moto simulada tampoco: el viaje de prueba es para las reales", async () => {
        const r = await restaurant();
        const sim = await createCourier({ status: "available", simulated: true });
        await db.insert(schema.courierProfiles).values({ courierId: sim.id, gpsDeviceId: "sim-abc" });
        const result = await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0, courierId: sim.id });
        assert.deepEqual(result, { error: "No es una moto real con GPS" });
      });

      it("si la moto no está conectada, el viaje se crea pero queda pendiente y se le dice cómo seguir", async () => {
        const r = await restaurant();
        const courier = await realGpsCourier("offline");
        const result = await order.createSimulatedOrder({ restaurantId: r.id, ...NEAR, readyInMinutes: 0, courierId: courier.id });
        assert.ok("error" in result);
        assert.match(String((result as { error: string }).error), /^Se creó el [A-Z]-\d{2}, pero la moto no está conectada: escríbele «hola» al bot/);
        const [trip] = await trips();
        assert.equal(trip.status, "pending");
        assert.equal(sent.length, 0);
      });
    });
  });

  describe("POST /api/internal/simulador", () => {
    const post = (body: unknown, headers: Record<string, string> = { "x-internal-secret": SECRET }) =>
      route.POST(new Request("http://bot.test/api/internal/simulator", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
    const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

    it("sin SIMULATOR_ENABLED no existe: 404 (y no crea nada)", async () => {
      delete process.env.SIMULATOR_ENABLED;
      const r = await restaurant();
      const res = await post({ action: "order", restaurantId: r.id, ...NEAR });
      assert.equal(res.status, 404);
      assert.equal((await trips()).length, 0);
    });

    it("sin el secreto interno (o con uno equivocado): 401 (y no crea nada)", async () => {
      const r = await restaurant();
      for (const headers of [{}, { "x-internal-secret": "otro" }, { "x-internal-secret": "" }] as Record<string, string>[]) {
        const res = await post({ action: "order", restaurantId: r.id, ...NEAR }, headers);
        assert.equal(res.status, 401);
      }
      assert.equal((await trips()).length, 0);
    });

    it("«order» crea el pedido y devuelve su id y su código", async () => {
      const r = await restaurant();
      const res = await post({ action: "order", restaurantId: r.id, ...NEAR, readyInMinutes: 5 });
      assert.equal(res.status, 200);
      const [trip] = await trips();
      assert.deepEqual(await json(res), { tripId: trip.id, code: trip.code });
    });

    it("los minutos de espera se acotan de 0 a 180 y se redondean", async () => {
      const r = await restaurant();
      const readyIn = async (readyInMinutes: unknown) => {
        await db.delete(schema.trips);
        const before = Date.now();
        await post({ action: "order", restaurantId: r.id, ...NEAR, readyInMinutes });
        const [trip] = await trips();
        return Math.round((trip.readyAt!.getTime() - before) / 60_000);
      };
      assert.equal(await readyIn(-30), 0);
      assert.equal(await readyIn(9_999), 180);
      assert.equal(await readyIn(10.4), 10);
      assert.equal(await readyIn("diez"), 0, "lo que no es número cuenta como ya listo");
    });

    it("un error de la creación se devuelve como 400 con su motivo (`reason`): es lo que el portal le muestra a la central", async () => {
      const r = await restaurant();
      await db.delete(schema.settings);
      const res = await post({ action: "order", restaurantId: r.id, ...NEAR });
      assert.equal(res.status, 400);
      const body = await json(res);
      assert.equal(body.reason, "La tabla de tarifas por km está vacía: no se puede cotizar.");
      assert.equal(body.error, body.reason);
    });

    it("el viaje de prueba de una moto real: courierId pasa hasta la asignación", async () => {
      const r = await restaurant();
      const courier = await realGpsCourier();
      const res = await post({ action: "order", restaurantId: r.id, ...NEAR, courierId: courier.id });
      assert.equal(res.status, 200);
      assert.equal((await trips())[0].status, "en_route");
    });

    for (const [name, body, error] of [
      ["sin restaurante", { action: "order", ...NEAR }, "Faltan el restaurante y el punto"],
      ["sin el punto", { action: "order", restaurantId: 1 }, "Faltan el restaurante y el punto"],
      ["con la latitud como texto", { action: "order", restaurantId: 1, lat: "3.46", lng: -76.53 }, "Faltan el restaurante y el punto"],
      ["«act» sin la moto o el viaje", { action: "act", courierId: 1 }, "Faltan courierId y tripId"],
      ["«debt» sin el pendiente", { action: "debt", courierId: 1 }, "Faltan courierId y debtId"],
      ["una acción que no existe", { action: "volar" }, "Acción desconocida"],
      ["sin acción", {}, "Acción desconocida"],
    ] as const) {
      it(`${name}: 400 «${error}»`, async () => {
        const res = await post(body);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error });
        assert.equal((await trips()).length, 0);
      });
    }

    it("«setup» crea las motos simuladas si no hay ninguna, y no las duplica", async () => {
      const first = await json(await post({ action: "setup" }));
      assert.ok((first.created as number) > 0);
      const count = (await db.select().from(schema.couriers).where(eq(schema.couriers.simulated, true))).length;
      assert.ok(count > 0);
      const second = await json(await post({ action: "setup" }));
      assert.equal(second.created, 0);
      assert.equal((await db.select().from(schema.couriers).where(eq(schema.couriers.simulated, true))).length, count);
    });
  });
});
