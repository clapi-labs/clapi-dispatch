import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { errandReason } from "@dispatch/shared";
import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  bot,
  createConversation,
  createCourier,
  createRestaurant,
  createTrip,
  getConversation,
  getCourier,
  getTrip,
  installMocks,
  params,
  request,
  resetMocks,
  restoreMocks,
} from "@/test-support/portal-env";

/**
 * Encargos desde el portal (docs/INTERVENCION-MANUAL.md, «Encargos»): el panel
 * «Encargo» de Conversaciones (crear o no crear), el encargo en Viajes (con su
 * marca, sin alertas, asignado a mano, «No hacer») y en Finanzas. Las rutas se
 * llaman tal cual, contra la base de pruebas; el bot es de mentiras y se revisa
 * qué se le pidió. Sin `TEST_DATABASE_URL` se salta.
 */

type Thread = typeof import("./conversations/[id]/route");
type Trips = typeof import("./trips/route");
type Assign = typeof import("./trips/[id]/assign/route");
type Deliver = typeof import("./trips/[id]/deliver/route");
type Cancel = typeof import("./trips/[id]/cancel/route");
type Settlement = typeof import("./settlement/route");
let thread: Thread;
let trips: Trips;
let assign: Assign;
let deliver: Deliver;
let cancel: Cancel;
let settlement: Settlement;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  thread = await import("./conversations/[id]/route");
  trips = await import("./trips/route");
  assign = await import("./trips/[id]/assign/route");
  deliver = await import("./trips/[id]/deliver/route");
  cancel = await import("./trips/[id]/cancel/route");
  settlement = await import("./settlement/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

const REQUEST = "necesito que me compren un queso tajado en la salsamentaria";

/** Un restaurante cuyo chat el bot pasó a la central por un encargo. */
async function errandChat() {
  const chat = await createConversation({ displayName: "Burgers", botPaused: true, escalationReason: errandReason(REQUEST) });
  const restaurant = await createRestaurant({ name: "Burgers 77", phone: chat.phone, knownPickupAddress: "Cra 66 # 9-50", knownPickupLocation: { lat: 3.42, lng: -76.54 } });
  return { chat, restaurant };
}

const act = (id: number, body: unknown) => thread.POST(request("POST", `/api/conversations/${id}`, { body }), params({ id }));
const board = async () => (await (await trips.GET()).json()) as { id: number; kind: string; status: string; code: string; notes: string | null; deliveryFee: number; alertAt: string | null; blockageKind: string | null; dispatchNote: string | null }[];
const notifications = () => bot.calls.filter((c) => c.path === "/api/internal/notify").map((c) => c.body);

describe("encargos en el portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("el panel «Encargo» de Conversaciones", () => {
    it("«Crear encargo»: el viaje queda en Pendiente con su código y su precio, el chat vuelve al bot y el bot le confirma al restaurante", async () => {
      const { chat, restaurant } = await errandChat();
      const res = await act(chat.id, { action: "errand", create: true, price: 8_000 });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; tripId: number; code: string };
      assert.equal(body.ok, true);
      assert.match(body.code, /^[A-Z]-\d{2}$/);

      const trip = await getTrip(body.tripId);
      assert.deepEqual(
        [trip.kind, trip.status, trip.code, trip.deliveryFee, trip.notes, trip.restaurantId, trip.deliveryAddress],
        ["errand", "pending", body.code, 8_000, REQUEST, restaurant.id, "Cra 66 # 9-50"],
      );
      const resumed = await getConversation(chat.id);
      assert.deepEqual([resumed.botPaused, resumed.escalationReason], [false, null]);
      assert.deepEqual(notifications(), [{ errandCreated: [body.tripId] }]);
    });

    it("«No crear»: ningún viaje, el chat vuelve al bot y el bot no le escribe a nadie", async () => {
      const { chat } = await errandChat();
      const res = await act(chat.id, { action: "errand", create: false });
      assert.equal(res.status, 200);
      assert.equal((await db.select().from(schema.trips)).length, 0);
      const resumed = await getConversation(chat.id);
      assert.deepEqual([resumed.botPaused, resumed.escalationReason], [false, null]);
      assert.equal(bot.calls.length, 0);
    });

    it("sin precio no crea nada y el chat sigue esperando", async () => {
      const { chat } = await errandChat();
      for (const price of [undefined, "8000", -1, Number.NaN]) {
        const res = await act(chat.id, { action: "errand", create: true, price });
        assert.equal(res.status, 400);
      }
      assert.equal((await db.select().from(schema.trips)).length, 0);
      assert.equal((await getConversation(chat.id)).botPaused, true);
    });

    it("si el chat ya no espera un encargo (lo decidió otro, o volvió al bot): 409 y nada cambia", async () => {
      const { chat } = await errandChat();
      assert.equal((await act(chat.id, { action: "errand", create: true, price: 8_000 })).status, 200);
      assert.equal((await act(chat.id, { action: "errand", create: true, price: 8_000 })).status, 409);
      assert.equal((await act(chat.id, { action: "errand", create: false })).status, 409);
      assert.equal((await db.select().from(schema.trips)).length, 1);

      const other = await createConversation({ botPaused: true, escalationReason: "El restaurante dio datos confusos o pidió hablar con una persona." });
      assert.equal((await act(other.id, { action: "errand", create: false })).status, 409);
      assert.equal((await getConversation(other.id)).botPaused, true);
    });
  });

  describe("en Viajes", () => {
    it("sale marcado como encargo, en Pendiente, sin motivo del engine ni alertas aunque lleve rato", async () => {
      const { chat } = await errandChat();
      const { tripId } = (await (await act(chat.id, { action: "errand", create: true, price: 8_000 })).json()) as { tripId: number };
      const courier = await createCourier({ status: "available" });
      assert.equal((await assign.POST(request("POST", `/api/trips/${tripId}/assign`, { body: { courierId: courier.id } }), params({ id: tripId }))).status, 200);
      await db.update(schema.assignments).set({ assignedAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(schema.assignments.tripId, tripId));

      const [row] = await board();
      assert.deepEqual([row.id, row.kind, row.status, row.notes], [tripId, "errand", "en_route", REQUEST]);
      assert.deepEqual([row.alertAt, row.blockageKind, row.dispatchNote], [null, null, null]);
    });

    it("«Asignar» de siempre: la moto queda ocupada y el bot avisa la asignación", async () => {
      const { chat } = await errandChat();
      const { tripId } = (await (await act(chat.id, { action: "errand", create: true, price: 8_000 })).json()) as { tripId: number };
      bot.calls.length = 0;
      const courier = await createCourier({ status: "available" });
      const res = await assign.POST(request("POST", `/api/trips/${tripId}/assign`, { body: { courierId: courier.id } }), params({ id: tripId }));
      assert.equal(res.status, 200);
      assert.equal((await getTrip(tripId)).status, "en_route");
      assert.equal((await getCourier(courier.id)).status, "busy");
      assert.deepEqual(notifications(), [{ unassigned: [], assigned: [tripId] }]);
    });

    it("«No hacer»: un encargo pendiente se cancela sin avisarle a nadie", async () => {
      const { chat } = await errandChat();
      const { tripId } = (await (await act(chat.id, { action: "errand", create: true, price: 8_000 })).json()) as { tripId: number };
      bot.calls.length = 0;
      const res = await cancel.POST(request("POST", `/api/trips/${tripId}/cancel`), params({ id: tripId }));
      assert.equal(res.status, 200);
      assert.equal((await getTrip(tripId)).status, "cancelled");
      assert.equal(bot.calls.length, 0);
    });

    it("«No hacer» no cancela un domicilio ni un encargo que ya tiene moto", async () => {
      const order = await createTrip({ status: "pending" });
      assert.equal((await cancel.POST(request("POST", `/api/trips/${order.id}/cancel`), params({ id: order.id }))).status, 409);
      assert.equal((await getTrip(order.id)).status, "pending");

      const { chat } = await errandChat();
      const { tripId } = (await (await act(chat.id, { action: "errand", create: true, price: 8_000 })).json()) as { tripId: number };
      const courier = await createCourier({ status: "available" });
      await assign.POST(request("POST", `/api/trips/${tripId}/assign`, { body: { courierId: courier.id } }), params({ id: tripId }));
      assert.equal((await cancel.POST(request("POST", `/api/trips/${tripId}/cancel`), params({ id: tripId }))).status, 409);
      assert.equal((await getTrip(tripId)).status, "en_route");
    });
  });

  describe("en Finanzas", () => {
    it("entregado, cuenta con el precio de la central como cualquier viaje; cancelado, no", async () => {
      const { chat } = await errandChat();
      const { tripId } = (await (await act(chat.id, { action: "errand", create: true, price: 8_000 })).json()) as { tripId: number };
      const courier = await createCourier({ name: "Pedro", status: "available" });
      await assign.POST(request("POST", `/api/trips/${tripId}/assign`, { body: { courierId: courier.id } }), params({ id: tripId }));
      assert.equal((await deliver.POST(request("POST", `/api/trips/${tripId}/deliver`, { body: {} }), params({ id: tripId }))).status, 200);
      assert.equal((await getCourier(courier.id)).status, "available");

      // Otro que la central decidió no hacer.
      await db.update(schema.conversations).set({ botPaused: true, escalationReason: errandReason("me traes 30 envases") }).where(eq(schema.conversations.id, chat.id));
      const second = (await (await act(chat.id, { action: "errand", create: true, price: 5_000 })).json()) as { tripId: number };
      await cancel.POST(request("POST", `/api/trips/${second.tripId}/cancel`), params({ id: second.tripId }));

      const money = (await (await settlement.GET()).json()) as { total: number; deliveredCount: number; couriers: { courierId: number; earned: number }[] };
      assert.deepEqual([money.total, money.deliveredCount], [8_000, 1]);
      assert.deepEqual(money.couriers.map((c) => [c.courierId, c.earned]), [[courier.id, 8_000]]);
    });
  });
});
