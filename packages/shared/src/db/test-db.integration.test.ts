import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { db } from "./client";
import { assignments, conversations, couriers, restaurants, trips } from "./schema";
import {
  assertTestDatabaseUrl,
  closeTestDatabase,
  createAssignment,
  createConversation,
  createCourier,
  createRestaurant,
  createTrip,
  integrationSkip,
  resetDatabase,
} from "./test-db";

describe("assertTestDatabaseUrl", () => {
  it("acepta bases cuyo nombre contiene «test»", () => {
    assertTestDatabaseUrl("postgres://u:p@localhost:5432/dispatch_test");
    assertTestDatabaseUrl("postgres://u:p@localhost:5432/TEST?sslmode=disable");
  });

  it("rechaza bases sin «test» en el nombre, aunque el resto de la URL lo tenga", () => {
    assert.throws(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432/dispatch"), /contenga «test»/);
    assert.throws(() => assertTestDatabaseUrl("postgres://test:test@test-host:5432/dispatch"), /contenga «test»/);
    assert.throws(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432/"), /contenga «test»/);
  });

  it("rechaza lo que no es una URL", () => {
    assert.throws(() => assertTestDatabaseUrl("no es una url"), /no es una URL/);
  });
});

describe("test-db (Postgres)", { skip: integrationSkip }, () => {
  after(closeTestDatabase);
  beforeEach(resetDatabase);

  it("las factories crean filas válidas con teléfonos y códigos distintos", async () => {
    const [r1, r2] = [await createRestaurant(), await createRestaurant()];
    assert.notEqual(r1.phone, r2.phone);
    const [c1, c2] = [await createCourier(), await createCourier()];
    assert.notEqual(c1.phone, c2.phone);
    assert.equal(c1.status, "available");
    const [t1, t2] = [await createTrip(), await createTrip()];
    assert.notEqual(t1.code, t2.code);
    assert.equal(t1.status, "pending");
    assert.notEqual(t1.conversationId, t2.conversationId);
  });

  it("las factories respetan lo que se les pasa", async () => {
    const restaurant = await createRestaurant({ name: "Donde Lucho" });
    const conversation = await createConversation({ phone: "573009999999" });
    const courier = await createCourier({ name: "Pedro", status: "busy" });
    const trip = await createTrip({ status: "en_route", restaurantId: restaurant.id, conversationId: conversation.id });
    assert.equal(restaurant.name, "Donde Lucho");
    assert.equal(conversation.phone, "573009999999");
    assert.deepEqual([courier.name, courier.status], ["Pedro", "busy"]);
    assert.deepEqual([trip.status, trip.restaurantId, trip.conversationId], ["en_route", restaurant.id, conversation.id]);
  });

  it("createTrip con conversationId null no crea conversación", async () => {
    const trip = await createTrip({ conversationId: null });
    assert.equal(trip.conversationId, null);
    assert.equal((await db.select().from(conversations)).length, 0);
  });

  it("createAssignment liga viaje y moto sin tocar sus estados", async () => {
    const [courier, trip] = [await createCourier({ name: "Luis" }), await createTrip()];
    const row = await createAssignment({ tripId: trip.id, courierId: courier.id, seenAt: new Date() });
    assert.deepEqual([row.tripId, row.courierId, row.courierName], [trip.id, courier.id, `Moto ${courier.id}`]);
    assert.ok(row.seenAt);
    assert.equal((await db.select().from(trips))[0].status, "pending");
    assert.equal((await db.select().from(couriers))[0].status, "available");
  });

  it("resetDatabase vacía todas las tablas y reinicia los ids", async () => {
    const courier = await createCourier();
    const trip = await createTrip();
    await createRestaurant();
    await createAssignment({ tripId: trip.id, courierId: courier.id });
    await resetDatabase();
    for (const table of [restaurants, conversations, couriers, trips, assignments]) {
      assert.equal((await db.select().from(table)).length, 0);
    }
    assert.equal((await createCourier()).id, 1);
    assert.equal((await createTrip()).id, 1);
  });
});
