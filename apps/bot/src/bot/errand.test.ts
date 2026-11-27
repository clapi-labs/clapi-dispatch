import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { assignTripTo, createErrandTrip, db, dismissErrand, getDemandConfig, measureDemand, schema } from "@dispatch/shared/db";
import { errandReason } from "@dispatch/shared";
import { closeTestDatabase, createCourier, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  buttonFrom,
  classifier,
  engineCalls,
  getAssignment,
  getConversation,
  getCourier,
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
  setAssignment,
  textFrom,
  world,
  type World,
} from "@/test-support/bot-env";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * Encargos de punta a punta desde el bot (docs/FLUJO-DOMICILIARIO.md,
 * «Encargos»): la central lo crea o no desde el panel, el engine y la demanda lo
 * ignoran, al domiciliario le llega un solo mensaje con un solo botón, y queda
 * ocupado hasta tocar «Entregado». WhatsApp y el engine son de mentiras; la
 * base es la de verdad. Sin `TEST_DATABASE_URL` se salta.
 */

type Courier = typeof import("./courier");
type Notify = typeof import("./notify");
type Engine = typeof import("@/dispatch/engine");
let courier: Courier;
let notify: Notify;
let dispatch: Engine;
let savedUrl: string | undefined;

const REQUEST = "necesito que me compren un queso tajado en la salsamentaria";

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  savedUrl = process.env.ENGINE_URL;
  process.env.ENGINE_URL = "http://engine.test:3003/";
  courier = await import("./courier");
  notify = await import("./notify");
  dispatch = await import("@/dispatch/engine");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  process.env.ENGINE_URL = "http://engine.test:3003/";
  delete process.env.SIMULATOR_ENABLED;
});

/** El chat del restaurante como lo deja el bot al reconocer un encargo (#131). */
const escalateErrand = (w: World, text = REQUEST) =>
  db.update(schema.conversations).set({ botPaused: true, escalationReason: errandReason(text) }).where(eq(schema.conversations.id, w.restaurantConversation.id));

/** El encargo creado desde el panel, con el precio de la central. */
async function errand(w: World, price = 8_000) {
  await escalateErrand(w);
  const created = await createErrandTrip(w.restaurantConversation.id, price);
  assert.ok(created.ok, "se crea el encargo");
  return created.value;
}

/** La central lo asigna en Viajes. */
async function assignErrand(w: World, tripId: number, who = w.courier) {
  assert.ok(await assignTripTo(tripId, who.id, { byHand: true }), "la central lo asigna");
  await notify.notifyAssigned(tripId);
}

async function act(w: World, message: IncomingMessage) {
  const found = await courier.findCourier(w.courier.phone);
  assert.ok(found);
  await courier.handleCourier(found, await getConversation(w.courierConversation.id), message);
}
const tap = (w: World, id: string) => act(w, buttonFrom(w.courier.phone, id));
const write = (w: World, text: string) => act(w, textFrom(w.courier.phone, text));
const toCourier = (w: World) => sentTo(w.courier.phone);
const toRestaurant = (w: World) => sentTo(w.restaurantConversation.phone);

describe("encargos (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    if (savedUrl === undefined) delete process.env.ENGINE_URL;
    else process.env.ENGINE_URL = savedUrl;
    restoreMocks();
    await closeTestDatabase();
  });

  describe("crear o no crear desde el panel (db/errands.ts)", () => {
    it("crear: un viaje de tipo encargo, pendiente, con código de la serie, el precio de la central, lo que pidió tal cual y la entrega en el restaurante; el chat vuelve al bot", async () => {
      const w = await world();
      const trip = await errand(w);
      assert.equal(trip.kind, "errand");
      assert.equal(trip.status, "pending");
      assert.match(trip.code, /^[A-Z]-\d{2}$/);
      assert.equal(trip.deliveryFee, 8_000);
      assert.equal(trip.notes, REQUEST);
      assert.equal(trip.restaurantId, w.restaurant.id);
      assert.equal(trip.conversationId, w.restaurantConversation.id);
      assert.equal(trip.originRestaurantName, "Pizza Nona");
      assert.equal(trip.pickupAddress, null, "la tienda no se sabe: no hay recogida");
      assert.equal(trip.deliveryAddress, "Calle 5 # 38-10");
      assert.deepEqual(trip.deliveryLocation, PICKUP);
      const chat = await getConversation(w.restaurantConversation.id);
      assert.deepEqual([chat.botPaused, chat.escalationReason], [false, null]);
    });

    it("crear dos veces (doble clic) no crea dos encargos", async () => {
      const w = await world();
      await errand(w);
      assert.deepEqual(await createErrandTrip(w.restaurantConversation.id, 8_000), { ok: false, reason: "not_errand" });
      assert.equal((await db.select().from(schema.trips)).length, 1);
    });

    it("no crear: el chat vuelve al bot, sin viaje", async () => {
      const w = await world();
      await escalateErrand(w);
      assert.deepEqual(await dismissErrand(w.restaurantConversation.id), { ok: true, value: null });
      assert.equal((await db.select().from(schema.trips)).length, 0);
      const chat = await getConversation(w.restaurantConversation.id);
      assert.deepEqual([chat.botPaused, chat.escalationReason], [false, null]);
    });

    it("un chat que no espera un encargo no se toca", async () => {
      const w = await world();
      await db.update(schema.conversations).set({ botPaused: true, escalationReason: "El restaurante dio datos confusos." }).where(eq(schema.conversations.id, w.restaurantConversation.id));
      assert.deepEqual(await createErrandTrip(w.restaurantConversation.id, 8_000), { ok: false, reason: "not_errand" });
      assert.deepEqual(await dismissErrand(w.restaurantConversation.id), { ok: false, reason: "not_errand" });
      assert.equal((await getConversation(w.restaurantConversation.id)).botPaused, true);
    });

    it("al crearlo, el bot le confirma al restaurante con su código", async () => {
      const w = await world();
      const trip = await errand(w);
      await notify.notifyErrandCreated(trip.id);
      const [msg] = toRestaurant(w);
      assert.match(msg.text, new RegExp(`Listo ✅ Tu encargo ${trip.code} quedó registrado\\. Te aviso cuando salga el domiciliario`));
    });
  });

  describe("el algoritmo y la demanda lo ignoran", () => {
    it("el engine nunca asigna un encargo, aunque haya motos libres", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await errand(w);
      assert.deepEqual(await dispatch.runEngine(), []);
      assert.equal(await dispatch.dispatchTrip(trip.id), false);
      assert.equal(engineCalls.length, 0, "ni se le pregunta");
      assert.equal((await getTrip(trip.id)).status, "pending");
    });

    it("mientras la moto tiene un encargo, el engine no le asigna otro pedido; al entregarlo, sí", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await errand(w);
      await assignErrand(w, trip.id);
      const order = await pendingTrip(w);

      assert.deepEqual(await dispatch.runEngine(), []);
      assert.deepEqual((engineCalls.at(-1) as { motos: unknown[] }).motos, [], "la moto del encargo no entra en la foto de la flota");
      assert.equal((await getTrip(order.id)).status, "pending");

      await tap(w, `done:customer:finish:${trip.id}`);
      assert.deepEqual(await dispatch.runEngine(), [order.id]);
      assert.equal((await getAssignment(order.id)).courierId, w.courier.id);
    });

    it("la demanda no cuenta los encargos: ni esperando, ni como llegada", async () => {
      const w = await world({ courier: liveCourier() });
      await errand(w);
      const metrics = await measureDemand(await getDemandConfig());
      assert.deepEqual([metrics.waiting, metrics.scheduled, metrics.arrivals], [0, 0, 0]);
      await pendingTrip(w);
      const withOrder = await measureDemand(await getDemandConfig());
      assert.deepEqual([withOrder.waiting + withOrder.scheduled, withOrder.arrivals], [1, 1]);
    });
  });

  describe("al domiciliario: un solo mensaje con un solo botón", () => {
    it("trae el código, el restaurante, lo que pidió tal cual y a dónde llevarlo con Waze; su único botón es «Entregado»", async () => {
      const w = await world();
      const trip = await errand(w);
      await assignErrand(w, trip.id);
      const sent = toCourier(w);
      assert.equal(sent.length, 1, "un solo mensaje");
      const text = plain(sent[0].text);
      assert.match(text, new RegExp(`^🛍️ \\*Pedro, tienes un encargo ${trip.code}\\*`));
      assert.match(text, /\*Para:\* Pizza Nona/);
      assert.match(text, new RegExp(`\\*Lo que pidió:\\* ${REQUEST}`));
      assert.match(text, /\*Llévalo a:\* Pizza Nona · Calle 5 # 38-10/);
      assert.match(text, /\*Ruta en Waze:\* https:\/\/waze\.com\/ul\?ll=3\.45,-76\.53&navigate=yes/);
      assert.ok(!/Recogí|Voy en camino|datáfono/i.test(text), "nada del flujo de un domicilio");
      assert.deepEqual(sent[0].buttons, [{ id: `done:customer:finish:${trip.id}`, title: "✅ Entregado" }]);
    });

    it("al restaurante le llega quién va con su encargo, aunque el aviso de asignación esté apagado", async () => {
      const w = await world();
      const trip = await errand(w);
      await assignErrand(w, trip.id);
      assert.deepEqual(toRestaurant(w).map((m) => m.text), [`🛵 Va Pedro con tu encargo ${trip.code}.`]);
    });

    it("si pide la ficha otra vez, le llega la del encargo", async () => {
      const w = await world();
      const trip = await errand(w);
      await assignErrand(w, trip.id);
      outbox.length = 0;
      const ticket = await notify.sendCourierTicket(w.courier.phone, await getTrip(trip.id), "Pedro Gómez", await getAssignment(trip.id));
      assert.ok(ticket.ok);
      assert.deepEqual(toCourier(w)[0].buttons.map((b) => b.id), [`done:customer:finish:${trip.id}`]);
    });
  });

  describe("ocupado mientras lo tiene, libre al entregarlo", () => {
    it("asignado queda ocupado; al tocar «Entregado» el viaje queda entregado y la moto libre", async () => {
      const w = await world();
      const trip = await errand(w);
      await assignErrand(w, trip.id);
      assert.equal((await getCourier(w.courier.id)).status, "busy");
      assert.equal((await getTrip(trip.id)).status, "en_route");
      outbox.length = 0;

      await tap(w, `done:customer:finish:${trip.id}`);
      assert.equal((await getTrip(trip.id)).status, "delivered");
      assert.equal((await getAssignment(trip.id)).deliveryPlace, "customer");
      assert.equal((await getCourier(w.courier.id)).status, "available");
      assert.match(plain(toCourier(w)[0].text), new RegExp(`✅ ${trip.code} terminado\\.`));
      assert.match(plain(toRestaurant(w)[0].text), new RegExp(`🛍️ Encargo ${trip.code} entregado a las`));
    });

    it("escribir «entregado» también lo cierra; «ok» no es «Voy en camino» y «ya recogí» no aplica", async () => {
      const w = await world();
      const trip = await errand(w);
      await assignErrand(w, trip.id);
      outbox.length = 0;
      // Sin otro sentido, cada uno pasa por el clasificador: que no sea una novedad.
      classifier.next({ tipo: "otro" });
      classifier.next({ tipo: "otro" });

      await write(w, "ok");
      assert.equal((await getAssignment(trip.id)).seenAt, null);
      await write(w, "ya recogí");
      assert.equal((await getAssignment(trip.id)).pickedUpAt, null);
      await write(w, "entregado");
      assert.equal((await getTrip(trip.id)).status, "delivered");
      assert.equal((await getCourier(w.courier.id)).status, "available");
    });

    it("no le llegan los recordatorios de un domicilio, aunque pase mucho tiempo", async () => {
      const w = await world();
      const trip = await errand(w);
      await assignErrand(w, trip.id);
      await setAssignment(trip.id, { assignedAt: minutesAgo(90) });
      outbox.length = 0;
      assert.deepEqual(await notify.remindCouriers(), []);
      assert.equal(outbox.length, 0);
    });

    it("un encargo no cuenta para «llevo datáfono»: no hay de qué restaurante", async () => {
      const w = await world();
      const trip = await errand(w);
      await assignErrand(w, trip.id);
      outbox.length = 0;
      await write(w, "llevo datáfono");
      assert.equal((await db.select().from(schema.returnDebts)).length, 0);
    });

    it("el encargo no se guarda como ruta de la moto", async () => {
      const w = await world();
      const other = await createCourier({ name: "Otra Moto" });
      const trip = await errand(w);
      await assignErrand(w, trip.id, other);
      assert.equal((await getAssignment(trip.id)).courierId, other.id);
      const routes = await db.select().from(schema.courierRoutes);
      assert.equal(routes.length, 0, "el encargo no se guarda como paradas");
    });
  });
});
