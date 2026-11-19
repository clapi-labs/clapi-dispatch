import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import { assignedTrip, createCourier, createConversation, getAssignment, getConversation, installMocks, params, request, resetMocks, restoreMocks } from "@/test-support/portal-env";

/**
 * Cuerpos raros: cada ruta de la API que lee JSON recibe lo que un cliente
 * roto, un script o alguien con malas intenciones puede mandar (texto que no es
 * JSON, `null`, un número, una lista…). Ninguna puede dar un error del
 * servidor (500) ni cambiar nada por ello. Antes, `null` (JSON válido) hacía
 * `body.algo` sobre `null` y daba 500 en varias; y en dos rutas un cuerpo vacío
 * habría sido peligroso si se hubiera tratado como `{}`: `assign` le quitaba el
 * pedido a quien lo llevaba y `profile` borraba la ficha. Las rutas se llaman tal
 * cual, contra la base de pruebas. Sin `TEST_DATABASE_URL` se salta.
 */

type Handler = (req: Request) => Promise<Response>;
const handlers: Record<string, Handler> = {};

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  const id = params({ id: 99_999 });
  const login = await import("./auth/login/route");
  const session = await import("./auth/session/route");
  const conversation = await import("./conversations/[id]/route");
  const couriers = await import("./couriers/route");
  const courier = await import("./couriers/[id]/route");
  const profile = await import("./couriers/[id]/profile/route");
  const debts = await import("./pendientes/route");
  const debt = await import("./pendientes/[id]/route");
  const assign = await import("./trips/[id]/assign/route");
  const deliver = await import("./trips/[id]/deliver/route");
  const simulator = await import("./simulador/route");
  const probe = await import("./zonas/probar/route");
  const zones = await import("./zonas/route");
  const zone = await import("./zonas/[id]/route");
  const ranges = await import("./fares/ranges/route");
  const adjustments = await import("./fares/ajustes/route");
  const business = await import("./business/route");
  const hours = await import("./service-hours/route");
  const demand = await import("./demanda/route");
  const restaurants = await import("./restaurants/route");
  const restaurant = await import("./restaurants/[id]/route");
  const push = await import("./push/route");
  Object.assign(handlers, {
    "POST /api/auth/login": (r: Request) => login.POST(r),
    "POST /api/auth/session": (r: Request) => session.POST(r),
    "POST /api/conversations/:id": (r: Request) => conversation.POST(r, id),
    "POST /api/couriers": (r: Request) => couriers.POST(r),
    "PATCH /api/couriers/:id": (r: Request) => courier.PATCH(r, id),
    "PUT /api/couriers/:id/profile": (r: Request) => profile.PUT(r, id),
    "POST /api/pendientes": (r: Request) => debts.POST(r),
    "PUT /api/pendientes": (r: Request) => debts.PUT(r),
    "POST /api/pendientes/:id": (r: Request) => debt.POST(r, id),
    "POST /api/trips/:id/assign": (r: Request) => assign.POST(r, id),
    "POST /api/trips/:id/deliver": (r: Request) => deliver.POST(r, id),
    "POST /api/simulador": (r: Request) => simulator.POST(r),
    "POST /api/zonas/probar": (r: Request) => probe.POST(r),
    "POST /api/zonas": (r: Request) => zones.POST(r),
    "PUT /api/zonas/:id": (r: Request) => zone.PUT(r, id),
    "PUT /api/fares/ranges": (r: Request) => ranges.PUT(r),
    "PUT /api/fares/ajustes": (r: Request) => adjustments.PUT(r),
    "PUT /api/business": (r: Request) => business.PUT(r),
    "PUT /api/service-hours": (r: Request) => hours.PUT(r),
    "PUT /api/demanda": (r: Request) => demand.PUT(r),
    "POST /api/restaurants": (r: Request) => restaurants.POST(r),
    "PUT /api/restaurants/:id": (r: Request) => restaurant.PUT(r, id),
    "PATCH /api/restaurants/:id": (r: Request) => restaurant.PATCH(r, id),
    "POST /api/push": (r: Request) => push.POST(r),
    "DELETE /api/push": (r: Request) => push.DELETE(r),
  } satisfies Record<string, Handler>);
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  process.env.SIMULATOR_ENABLED = "1";
});

const NOT_OBJECTS = [
  ["que no es JSON", "esto no es json"],
  ["vacío", ""],
  ["null", "null"],
  ["una lista", "[]"],
  ["una lista con un objeto", '[{"action":"pause"}]'],
  ["un número", "5"],
  ["un texto", '"hola"'],
  ["true", "true"],
] as const;

const send = (name: string, raw: string) => {
  const [method, path] = name.split(" ");
  return handlers[name](request(method, path.replace(":id", "99999"), { raw: raw === "" ? undefined : raw, headers: { "Content-Type": "application/json" } }));
};

describe("cuerpos raros en la API del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    delete process.env.SIMULATOR_ENABLED;
    restoreMocks();
    await closeTestDatabase();
  });

  it("se están probando todas las rutas que leen JSON", () => {
    assert.ok(Object.keys(handlers).length >= 25, `solo ${Object.keys(handlers).length}`);
  });

  for (const [label, raw] of NOT_OBJECTS) {
    it(`un cuerpo ${label}: ninguna ruta da un error del servidor`, async () => {
      const failures: string[] = [];
      for (const name of Object.keys(handlers)) {
        try {
          const res = await send(name, raw);
          if (res.status >= 500) failures.push(`${name} → ${res.status}`);
        } catch (error) {
          failures.push(`${name} → lanzó ${error instanceof Error ? error.message.slice(0, 60) : error}`);
        }
      }
      assert.deepEqual(failures, [], `con cuerpo ${label}`);
    });
  }

  it("un objeto vacío tampoco rompe nada (en las rutas que no guardan algo por sí solo)", async () => {
    const failures: string[] = [];
    // La ficha del motorizado con `{}` es una orden válida (dejar todo en blanco) y sobre un motorizado que no existe falla por la llave foránea: va aparte.
    for (const name of Object.keys(handlers).filter((n) => n !== "PUT /api/couriers/:id/profile")) {
      try {
        const res = await send(name, "{}");
        if (res.status >= 500) failures.push(`${name} → ${res.status}`);
      } catch (error) {
        failures.push(`${name} → lanzó ${error instanceof Error ? error.message.slice(0, 60) : error}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  describe("y no cambian nada por ello", () => {
    it("un cuerpo que no es un objeto no le quita el pedido a quien lo lleva (assign)", async () => {
      delete process.env.SIMULATOR_ENABLED; // con el simulador encendido el despacho solo asigna motos simuladas
      const courier = await createCourier({ status: "available" });
      const trip = await assignedTrip(courier.id);
      const real = await import("./trips/[id]/assign/route");
      for (const [, raw] of NOT_OBJECTS) {
        const res = await real.POST(request("POST", `/api/trips/${trip.id}/assign`, { raw: raw || undefined }), params({ id: trip.id }));
        assert.equal(res.status, 400, raw);
      }
      assert.equal((await getAssignment(trip.id)).courierId, courier.id);
    });

    it("un cuerpo que no es un objeto no borra la ficha del motorizado (profile)", async () => {
      const courier = await createCourier();
      await db.insert(schema.courierProfiles).values({ courierId: courier.id, vehiclePlate: "ABC12D", vehicleType: "Moto" });
      const real = await import("./couriers/[id]/profile/route");
      for (const [, raw] of NOT_OBJECTS) {
        const res = await real.PUT(request("PUT", `/api/couriers/${courier.id}/profile`, { raw: raw || undefined }), params({ id: courier.id }));
        assert.equal(res.status, 400, raw);
        assert.deepEqual(await res.json(), { error: "Cuerpo inválido" });
      }
      const [row] = await db.select().from(schema.courierProfiles);
      assert.deepEqual([row.vehiclePlate, row.vehicleType], ["ABC12D", "Moto"]);
    });

    it("un cuerpo que no es un objeto no toca el chat (conversations)", async () => {
      const chat = await createConversation({ botPaused: true, escalationReason: "Novedad de Pedro: x" });
      const real = await import("./conversations/[id]/route");
      for (const [, raw] of NOT_OBJECTS) {
        const res = await real.POST(request("POST", `/api/conversations/${chat.id}`, { raw: raw || undefined }), params({ id: chat.id }));
        assert.equal(res.status, 400, raw);
      }
      const row = await getConversation(chat.id);
      assert.deepEqual([row.botPaused, row.escalationReason], [true, "Novedad de Pedro: x"]);
    });

    it("el login con un cuerpo raro responde 400 y no abre ninguna sesión", async () => {
      const real = await import("./auth/login/route");
      for (const [, raw] of NOT_OBJECTS) {
        const res = await real.POST(request("POST", "/api/auth/login", { raw: raw || undefined, headers: { "x-forwarded-for": `10.9.9.${Math.floor(Math.random() * 200) + 1}` } }));
        assert.equal(res.status, 400, raw);
      }
      assert.equal((await db.select().from(schema.portalSessions)).length, 0);
    });
  });
});
