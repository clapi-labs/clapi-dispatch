import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { cancelReason } from "@dispatch/shared";
import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  bot,
  createConversation,
  createCourier,
  createTrip,
  getAssignment,
  getConversation,
  getCourier,
  getTrip,
  installMocks,
  params,
  request,
  resetMocks,
  restoreMocks,
  setAssignment,
} from "@/test-support/portal-env";

/**
 * Cancelar un viaje desde Viajes (`POST /api/trips/:id/cancel`): el motivo, el
 * cobro (por regla, si la moto ya salió del restaurante; la central lo puede
 * cambiar), la moto libre, el chat del restaurante que pidió cancelar de vuelta
 * al bot, los avisos y Finanzas. Sin `TEST_DATABASE_URL` se salta.
 */

type Cancel = typeof import("./[id]/cancel/route");
type Settlement = typeof import("../settlement/route");
let cancel: Cancel;
let settlement: Settlement;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  cancel = await import("./[id]/cancel/route");
  settlement = await import("../settlement/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

const cancelTrip = (id: number, body: unknown) => cancel.POST(request("POST", `/api/trips/${id}/cancel`, { body }), params({ id }));
const notifications = () => bot.calls.filter((c) => c.path === "/api/internal/notify").map((c) => c.body);
const money = async () => (await (await settlement.GET()).json()) as { total: number; deliveredCount: number; couriers: { courierId: number; earned: number }[] };

describe("cancelar un viaje (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  it("sin moto: queda cancelado con su motivo, sin cobro aunque se pida, y el bot avisa al restaurante", async () => {
    const trip = await createTrip({ status: "pending", deliveryFee: 8_000 });
    const res = await cancelTrip(trip.id, { reason: "El cliente canceló", charge: true });
    assert.equal(res.status, 200);
    const row = await getTrip(trip.id);
    assert.deepEqual([row.status, row.cancelReason, row.cancelFee], ["cancelled", "El cliente canceló", null]);
    assert.ok(row.cancelledAt);
    assert.deepEqual(notifications(), [{ cancelled: [{ tripId: trip.id, courierId: null, notifyRestaurant: true }] }]);
  });

  it("asignado y sin recoger: la moto queda libre, no le cuenta en el turno y no se cobra", async () => {
    const courier = await createCourier({ status: "available" });
    const trip = await assignedTrip(courier.id, { deliveryFee: 8_000 });
    assert.equal((await getCourier(courier.id)).deliveriesThisShift, 1);

    await cancelTrip(trip.id, { reason: "Lo pidió el restaurante", charge: false, notifyRestaurant: false });
    assert.deepEqual([(await getTrip(trip.id)).status, (await getTrip(trip.id)).cancelFee], ["cancelled", null]);
    const after = await getCourier(courier.id);
    assert.deepEqual([after.status, after.deliveriesThisShift], ["available", 0]);
    assert.ok((await getAssignment(trip.id)).finishedAt, "la asignación queda cerrada");
    assert.deepEqual(notifications(), [{ cancelled: [{ tripId: trip.id, courierId: courier.id, notifyRestaurant: false }] }]);
    assert.deepEqual([(await money()).total, (await money()).deliveredCount], [0, 0]);
  });

  it("ya salió del restaurante y se cobra: el domicilio cuenta en Finanzas para esa moto", async () => {
    const courier = await createCourier({ name: "Pedro", status: "available" });
    const trip = await assignedTrip(courier.id, { deliveryFee: 8_000 });
    await setAssignment(trip.id, { pickedUpAt: new Date() });

    const res = await cancelTrip(trip.id, { reason: "El cliente canceló", charge: true });
    assert.deepEqual(await res.json(), { ok: true, charged: 8_000 });
    assert.equal((await getCourier(courier.id)).deliveriesThisShift, 1, "con el pedido recogido, sí le cuenta");
    const m = await money();
    assert.deepEqual([m.total, m.deliveredCount], [8_000, 1]);
    assert.deepEqual(m.couriers.map((c) => [c.courierId, c.earned]), [[courier.id, 8_000]]);
  });

  it("la moto con otro pedido encima sigue ocupada", async () => {
    const courier = await createCourier({ status: "available" });
    const first = await assignedTrip(courier.id);
    await assignedTrip(courier.id);
    await cancelTrip(first.id, { reason: "Pedido duplicado o de prueba", charge: false });
    assert.equal((await getCourier(courier.id)).status, "busy");
  });

  it("el chat que pidió cancelar ese pedido vuelve al bot; uno pausado por otra cosa, no", async () => {
    const asked = await createConversation({ botPaused: true });
    const trip = await createTrip({ status: "pending", conversationId: asked.id });
    await db.update(schema.conversations).set({ escalationReason: cancelReason([trip.code]) }).where(eq(schema.conversations.id, asked.id));
    await cancelTrip(trip.id, { reason: "Lo pidió el restaurante", charge: false });
    const released = await getConversation(asked.id);
    assert.deepEqual([released.botPaused, released.escalationReason], [false, null]);

    const other = await createConversation({ botPaused: true, escalationReason: "Pidió cambiar la dirección del pedido" });
    const second = await createTrip({ status: "pending", conversationId: other.id });
    await cancelTrip(second.id, { reason: "Lo pidió el restaurante", charge: false });
    assert.equal((await getConversation(other.id)).botPaused, true);
  });

  it("un viaje entregado o ya cancelado no se cancela (409), y sin motivo o sin decir el cobro, 400", async () => {
    const delivered = await createTrip({ status: "delivered" });
    assert.equal((await cancelTrip(delivered.id, { reason: "x", charge: false })).status, 409);
    assert.equal((await getTrip(delivered.id)).status, "delivered");

    const open = await createTrip({ status: "pending" });
    assert.equal((await cancelTrip(open.id, { reason: "  ", charge: false })).status, 400);
    assert.equal((await cancelTrip(open.id, { reason: "El cliente canceló" })).status, 400);
    assert.equal((await getTrip(open.id)).status, "pending");

    await cancelTrip(open.id, { reason: "El cliente canceló", charge: false });
    assert.equal((await cancelTrip(open.id, { reason: "El cliente canceló", charge: false })).status, 409, "un doble clic no repite nada");
    assert.equal(notifications().length, 1);
  });
});
