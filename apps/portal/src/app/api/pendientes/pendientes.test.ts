import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, declareReturnDebt, getBotConfig, getReturnDebt, openDebtClaims, recordDebtClaim, resolveReturnDebtGroup, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  bot,
  browser,
  createCourier,
  createRestaurant,
  createUser,
  installMocks,
  minutesAgo,
  openSession,
  params,
  request,
  resetMocks,
  restoreMocks,
  setAssignment,
} from "@/test-support/portal-env";

/**
 * Pendientes de regreso desde el portal (/pendientes): el datáfono y la plata
 * que el motorizado debe devolver o pagar. La central los lista, los registra a
 * mano cuando el domiciliario no los declaró, los cierra («Lo resolví yo»),
 * manda a que los cierre («Mandar ya», por WhatsApp a través del bot) y atiende
 * los reclamos del restaurante. Las rutas se llaman tal cual, contra la base de
 * pruebas; el bot es de mentiras. Sin `TEST_DATABASE_URL` se salta.
 */

type Debts = typeof import("./route");
type DebtById = typeof import("./[id]/route");
let debts: Debts;
let byId: DebtById;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  debts = await import("./route");
  byId = await import("./[id]/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

type Listing = {
  open: { id: number; courierName: string; restaurantName: string; reason: string; tripCode: string | null; declaredBy: string }[];
  resolved: { id: number; resolvedBy: string | null; resolvedByName: string | null }[];
  claims: { id: number; restaurantName: string; reason: string | null; closing: boolean; why: string }[];
  datafonoAlertMinutes: number;
  closingDebtMinutes: number;
};
const listing = async () => (await (await debts.GET()).json()) as Listing;
const declare = (body: unknown) => debts.POST(request("POST", "/api/pendientes", { body }));
const setMinutes = (body: unknown) => debts.PUT(request("PUT", "/api/pendientes", { body }));
const act = (id: number | string, body: unknown) => byId.POST(request("POST", `/api/pendientes/${id}`, { body }), params({ id }));
const notifications = () => bot.calls.filter((c) => c.path === "/api/internal/notify");

let codeSeq = 0;
/** Un código como los de verdad («B-12»): la ruta de pendientes los normaliza con esa forma. */
const nextCode = () => `B-${String(++codeSeq).padStart(2, "0")}`;

/** Una moto con un pedido entregado y su pendiente anotado por ella. */
async function owed(reason: "datafono" | "plata" = "datafono", over: { name?: string } = {}) {
  const restaurant = await createRestaurant({ name: "Pizza Nona" });
  const courier = await createCourier({ name: over.name ?? "Pedro Gómez", status: "available" });
  const trip = await assignedTrip(courier.id, { restaurantId: restaurant.id, originRestaurantName: restaurant.name, code: nextCode() });
  const { debt } = await declareReturnDebt({ courierId: courier.id, reason, restaurantName: restaurant.name, restaurantId: restaurant.id, tripId: trip.id, declaredBy: "courier" });
  return { restaurant, courier, trip, debt };
}
async function signIn() {
  const user = await createUser({ name: "Ana Central" });
  browser.cookie = (await openSession(user.id)).token;
  return user;
}

describe("pendientes de regreso del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("GET /api/pendientes", () => {
    it("sin nada: listas vacías y los minutos por defecto", async () => {
      assert.deepEqual(await listing(), { open: [], resolved: [], claims: [], datafonoAlertMinutes: 30, closingDebtMinutes: 30 });
    });

    it("los abiertos con su motorizado, restaurante, motivo y pedido, y quién los declaró", async () => {
      const { courier, trip } = await owed("datafono");
      const body = await listing();
      assert.equal(body.open.length, 1);
      assert.deepEqual([body.open[0].courierName, body.open[0].restaurantName, body.open[0].reason, body.open[0].tripCode, body.open[0].declaredBy], [courier.name, "Pizza Nona", "datafono", trip.code, "courier"]);
    });

    it("los cerrados salen en el historial de los últimos 7 días, con quién los cerró", async () => {
      const user = await signIn();
      const { debt } = await owed("plata");
      await act(debt.id, { action: "resolve" });
      const body = await listing();
      assert.equal(body.open.length, 0);
      assert.equal(body.resolved.length, 1);
      assert.deepEqual([body.resolved[0].resolvedBy, body.resolved[0].resolvedByName], ["central", user.name]);
    });

    it("lo cerrado hace más de 7 días ya no sale", async () => {
      const { debt } = await owed("plata");
      await act(debt.id, { action: "resolve" });
      await db.update(schema.returnDebts).set({ resolvedAt: new Date(Date.now() - 8 * 86400_000) }).where(eq(schema.returnDebts.id, debt.id));
      assert.equal((await listing()).resolved.length, 0);
    });

    it("los reclamos abiertos de los restaurantes", async () => {
      await recordDebtClaim({ restaurantName: "Pizza Nona", reason: "datafono", closing: false, why: "No hay ningún datáfono pendiente registrado" });
      const body = await listing();
      assert.deepEqual(body.claims.map((c) => [c.restaurantName, c.reason, c.closing]), [["Pizza Nona", "datafono", false]]);
    });
  });

  describe("POST /api/pendientes: la central registra uno a mano", () => {
    it("con el código del pedido: el restaurante y el viaje salen del pedido; queda como declarado por la central, y por quién", async () => {
      const user = await signIn();
      const restaurant = await createRestaurant({ name: "Donde Lucho" });
      const courier = await createCourier({ name: "Pedro", status: "available" });
      const trip = await assignedTrip(courier.id, { restaurantId: restaurant.id, originRestaurantName: restaurant.name, code: "A-07" });
      const res = await declare({ courierId: courier.id, reason: "datafono", tripCode: "A-07" });
      assert.equal(res.status, 201);
      const created = (await res.json()) as { id: number };
      const [row] = await db.select().from(schema.returnDebts).where(eq(schema.returnDebts.id, created.id));
      assert.deepEqual([row.restaurantName, row.restaurantId, row.tripId, row.declaredBy, row.declaredByUserId, row.courierId, row.reason], ["Donde Lucho", restaurant.id, trip.id, "central", user.id, courier.id, "datafono"]);
    });

    it("el código se acepta en minúsculas y sin guion («a07» es «A-07»)", async () => {
      const courier = await createCourier({ status: "available" });
      await assignedTrip(courier.id, { code: "A-07" });
      for (const written of ["a07", "A07", " a-07 ", "A-07"]) {
        await db.delete(schema.returnDebts);
        const res = await declare({ courierId: courier.id, reason: "plata", tripCode: written });
        assert.equal(res.status, 201, written);
      }
    });

    it("un código de un pedido que no es de ese motorizado: 404 con el nombre y el código", async () => {
      const pedro = await createCourier({ name: "Pedro", status: "available" });
      const luis = await createCourier({ name: "Luis", status: "available" });
      await assignedTrip(luis.id, { code: "A-07" });
      const res = await declare({ courierId: pedro.id, reason: "datafono", tripCode: "A-07" });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Pedro no tiene un pedido A-07" });
      assert.equal((await db.select().from(schema.returnDebts)).length, 0);
    });

    it("sin pedido, con el restaurante registrado por su id", async () => {
      const restaurant = await createRestaurant({ name: "Donde Lucho" });
      const courier = await createCourier();
      const res = await declare({ courierId: courier.id, reason: "plata", restaurantId: restaurant.id });
      assert.equal(res.status, 201);
      const [row] = await db.select().from(schema.returnDebts);
      assert.deepEqual([row.restaurantName, row.restaurantId, row.tripId], ["Donde Lucho", restaurant.id, null]);
    });

    it("sin pedido, con el nombre escrito (recortado a 120 caracteres)", async () => {
      const courier = await createCourier();
      const res = await declare({ courierId: courier.id, reason: "plata", restaurantName: `  ${"R".repeat(150)}  ` });
      assert.equal(res.status, 201);
      const [row] = await db.select().from(schema.returnDebts);
      assert.deepEqual([row.restaurantName.length, row.restaurantId], [120, null]);
    });

    it("un restaurante que ya no existe: 404", async () => {
      const courier = await createCourier();
      const res = await declare({ courierId: courier.id, reason: "plata", restaurantId: 99_999 });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Ese restaurante ya no existe" });
    });

    it("sin restaurante ni pedido: 400 «Falta el restaurante»", async () => {
      const courier = await createCourier();
      for (const extra of [{}, { restaurantName: "   " }, { restaurantName: 5 }]) {
        const res = await declare({ courierId: courier.id, reason: "plata", ...extra });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Falta el restaurante" });
      }
    });

    for (const [name, body] of [
      ["sin motorizado", { reason: "plata", restaurantName: "X" }],
      ["con un motorizado que no es número", { courierId: "pedro", reason: "plata", restaurantName: "X" }],
      ["con un motorizado decimal", { courierId: 1.5, reason: "plata", restaurantName: "X" }],
      ["sin motivo", { courierId: 1, restaurantName: "X" }],
      ["con un motivo que no existe", { courierId: 1, reason: "propina", restaurantName: "X" }],
      ["con un cuerpo vacío", {}],
    ] as const) {
      it(`${name}: 400 «Falta el domiciliario o el motivo»`, async () => {
        const res = await declare(body);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Falta el domiciliario o el motivo" });
      });
    }

    it("un cuerpo que no es JSON: 400", async () => {
      const res = await debts.POST(request("POST", "/api/pendientes", { raw: "no es json" }));
      assert.equal(res.status, 400);
    });

    it("un motorizado que ya no existe: 404", async () => {
      const res = await declare({ courierId: 99_999, reason: "plata", restaurantName: "X" });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Ese domiciliario ya no existe" });
    });

    it("el mismo pedido con el mismo motivo dos veces: 409 (un doble clic no crea otro)", async () => {
      const { courier, trip } = await owed("datafono");
      const res = await declare({ courierId: courier.id, reason: "datafono", tripCode: trip.code });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "Ese pedido ya tiene anotado el datáfono" });
      const plata = await declare({ courierId: courier.id, reason: "plata", tripCode: trip.code });
      assert.equal(plata.status, 201, "pero otro motivo del mismo pedido sí");
      const again = await declare({ courierId: courier.id, reason: "plata", tripCode: trip.code });
      assert.deepEqual(await again.json(), { error: "Ese pedido ya tiene anotado la plata" });
      assert.equal((await db.select().from(schema.returnDebts)).length, 2);
    });

    it("al registrarlo la central, el reclamo abierto de ese restaurante se da por atendido", async () => {
      const user = await signIn();
      const restaurant = await createRestaurant({ name: "Pizza Nona" });
      const courier = await createCourier();
      await recordDebtClaim({ restaurantId: restaurant.id, restaurantName: "Pizza Nona", reason: "datafono", closing: false, why: "No hay ningún datáfono pendiente registrado" });
      assert.equal((await openDebtClaims()).length, 1);
      await declare({ courierId: courier.id, reason: "datafono", restaurantId: restaurant.id });
      assert.equal((await openDebtClaims()).length, 0);
      const [claim] = await db.select().from(schema.returnDebtClaims);
      assert.equal(claim.handledByUserId, user.id);
    });

    it("sin sesión (login apagado) queda sin autor, pero se registra", async () => {
      const courier = await createCourier();
      const res = await declare({ courierId: courier.id, reason: "plata", restaurantName: "X" });
      assert.equal(res.status, 201);
      assert.equal((await db.select().from(schema.returnDebts))[0].declaredByUserId, null);
    });
  });

  describe("PUT /api/pendientes: los minutos de los avisos", () => {
    it("guarda los dos y la configuración del bot los lee", async () => {
      const res = await setMinutes({ datafonoAlertMinutes: 45, closingDebtMinutes: 20 });
      assert.deepEqual(await res.json(), { ok: true, datafonoAlertMinutes: 45, closingDebtMinutes: 20 });
      const config = await getBotConfig();
      assert.deepEqual([config.datafonoAlertMinutes, config.closingDebtMinutes], [45, 20]);
      assert.deepEqual([(await listing()).datafonoAlertMinutes, (await listing()).closingDebtMinutes], [45, 20]);
    });

    it("cambiar uno deja el otro como estaba", async () => {
      await setMinutes({ datafonoAlertMinutes: 45, closingDebtMinutes: 20 });
      assert.deepEqual(await (await setMinutes({ closingDebtMinutes: 15 })).json(), { ok: true, datafonoAlertMinutes: 45, closingDebtMinutes: 15 });
      assert.deepEqual(await (await setMinutes({ datafonoAlertMinutes: 60 })).json(), { ok: true, datafonoAlertMinutes: 60, closingDebtMinutes: 15 });
    });

    it("los topes: de 1 a 1.440 minutos, enteros", async () => {
      assert.equal((await setMinutes({ datafonoAlertMinutes: 1, closingDebtMinutes: 1440 })).status, 200);
      for (const bad of [0, -5, 1441, 2.5, "x", null, NaN]) {
        const alert = await setMinutes({ datafonoAlertMinutes: bad });
        assert.equal(alert.status, 400, `datáfono ${String(bad)}`);
        assert.match(((await alert.json()) as { error: string }).error, /Los minutos van de 1 a 1\.440/);
      }
      for (const bad of [0, 1441, 1.5, "x"]) {
        const closing = await setMinutes({ closingDebtMinutes: bad });
        assert.equal(closing.status, 400, `cierre ${String(bad)}`);
        assert.equal(((await closing.json()) as { error: string }).error, "Los minutos antes del cierre van de 1 a 1.440");
      }
    });

    it("un valor inválido no cambia el que estaba guardado", async () => {
      await setMinutes({ datafonoAlertMinutes: 45, closingDebtMinutes: 20 });
      await setMinutes({ datafonoAlertMinutes: 99_999 });
      const config = await getBotConfig();
      assert.deepEqual([config.datafonoAlertMinutes, config.closingDebtMinutes], [45, 20]);
    });
  });

  describe("POST /api/pendientes/:id: lo que hace la central con un pendiente", () => {
    describe("resolve: «Lo resolví yo»", () => {
      it("lo cierra, queda en el historial con quién lo cerró, y no llama al bot", async () => {
        const user = await signIn();
        const { debt } = await owed("plata");
        const res = await act(debt.id, { action: "resolve" });
        assert.deepEqual(await res.json(), { ok: true, closed: [debt.id] });
        const closed = await getReturnDebt(debt.id);
        assert.deepEqual([closed?.resolvedBy, closed?.resolvedByName], ["central", user.name]);
        assert.ok(closed?.resolvedAt);
        assert.equal(bot.calls.length, 0);
      });

      it("cierra todo el grupo (mismo motorizado, restaurante y motivo), no solo uno", async () => {
        const { restaurant, courier, debt } = await owed("plata");
        const second = await assignedTrip(courier.id, { restaurantId: restaurant.id, originRestaurantName: restaurant.name });
        const { debt: other } = await declareReturnDebt({ courierId: courier.id, reason: "plata", restaurantName: restaurant.name, restaurantId: restaurant.id, tripId: second.id, declaredBy: "courier" });
        const res = await act(debt.id, { action: "resolve" });
        assert.deepEqual(((await res.json()) as { closed: number[] }).closed.sort(), [debt.id, other.id].sort());
      });

      it("no cierra los de otro motivo ni los de otro restaurante", async () => {
        const { restaurant, courier, debt } = await owed("plata");
        const second = await assignedTrip(courier.id, { restaurantId: restaurant.id, originRestaurantName: restaurant.name });
        const { debt: datafono } = await declareReturnDebt({ courierId: courier.id, reason: "datafono", restaurantName: restaurant.name, restaurantId: restaurant.id, tripId: second.id, declaredBy: "courier" });
        await act(debt.id, { action: "resolve" });
        assert.equal((await getReturnDebt(datafono.id))?.resolvedAt, null);
      });

      it("el reclamo del restaurante se cierra con él", async () => {
        const { restaurant, debt } = await owed("plata");
        await recordDebtClaim({ restaurantId: restaurant.id, restaurantName: restaurant.name, reason: "plata", closing: false, why: "x" });
        await act(debt.id, { action: "resolve" });
        assert.equal((await openDebtClaims()).length, 0);
      });

      it("uno ya resuelto: 409 «Ya estaba resuelto» y no cambia nada", async () => {
        const { debt } = await owed("plata");
        await act(debt.id, { action: "resolve" });
        const at = (await getReturnDebt(debt.id))?.resolvedAt;
        const res = await act(debt.id, { action: "resolve" });
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: "Ya estaba resuelto" });
        assert.equal((await getReturnDebt(debt.id))?.resolvedAt?.getTime(), at?.getTime());
      });

      it("uno que no existe, o un id que no es número: 404", async () => {
        for (const id of [99_999, "abc", "1.5"]) {
          const res = await act(id, { action: "resolve" });
          assert.equal(res.status, 404, String(id));
          assert.deepEqual(await res.json(), { error: "Ese pendiente ya no existe" });
        }
      });

      it("la central puede cerrar un datáfono aunque su pedido todavía no se entregue (el motorizado no podría)", async () => {
        const { courier, debt } = await owed("datafono");
        assert.deepEqual(await resolveReturnDebtGroup(debt.id, { kind: "courier" }), [], "el motorizado no puede: el pedido sigue en la calle");
        const res = await act(debt.id, { action: "resolve" });
        assert.deepEqual(await res.json(), { ok: true, closed: [debt.id] });
        assert.ok(courier);
      });
    });

    describe("nudge: «Mandar ya»", () => {
      it("le pide al bot que le escriba al motorizado, con el id del pendiente", async () => {
        const { debt } = await owed("datafono");
        const res = await act(debt.id, { action: "nudge" });
        assert.deepEqual(await res.json(), { ok: true });
        assert.deepEqual(notifications().map((c) => c.body), [{ debtNudge: debt.id }]);
        assert.equal((await getReturnDebt(debt.id))?.resolvedAt, null, "no lo cierra: lo cierra el motorizado al devolverlo");
      });

      it("si el bot no pudo (o no responde): 502 «No se pudo enviar el WhatsApp»", async () => {
        const { debt } = await owed("datafono");
        for (const reply of [{ status: 500, body: {} }, { status: 401, body: {} }, "network"] as const) {
          bot.reply(reply);
          const res = await act(debt.id, { action: "nudge" });
          assert.equal(res.status, 502);
          assert.deepEqual(await res.json(), { error: "No se pudo enviar el WhatsApp" });
        }
      });

      it("si el bot dice que ya estaba cerrado: 502 «Ya estaba resuelto»", async () => {
        const { debt } = await owed("datafono");
        bot.reply({ status: 409, body: { reason: "closed" } });
        const res = await act(debt.id, { action: "nudge" });
        assert.equal(res.status, 502);
        assert.deepEqual(await res.json(), { error: "Ya estaba resuelto" });
      });

      it("de un pendiente ya resuelto: 409 sin molestar al bot", async () => {
        const { debt } = await owed("plata");
        await act(debt.id, { action: "resolve" });
        const res = await act(debt.id, { action: "nudge" });
        assert.equal(res.status, 409);
        assert.equal(bot.calls.length, 0);
      });
    });

    describe("handle_claim: «Lo resuelvo yo» (un reclamo del restaurante)", () => {
      it("lo marca atendido, con quién", async () => {
        const user = await signIn();
        const claim = await recordDebtClaim({ restaurantName: "Pizza Nona", reason: "datafono", closing: false, why: "x" });
        const res = await act(claim.id, { action: "handle_claim" });
        assert.deepEqual(await res.json(), { ok: true });
        const [row] = await db.select().from(schema.returnDebtClaims);
        assert.deepEqual([row.handledByUserId, !!row.handledAt], [user.id, true]);
        assert.equal((await listing()).claims.length, 0);
      });

      it("uno ya atendido o que no existe: 404 «Ese reclamo ya estaba atendido»", async () => {
        const claim = await recordDebtClaim({ restaurantName: "Pizza Nona", reason: null, closing: true, why: "x" });
        await act(claim.id, { action: "handle_claim" });
        for (const id of [claim.id, 99_999, "abc"]) {
          const res = await act(id, { action: "handle_claim" });
          assert.equal(res.status, 404, String(id));
          assert.deepEqual(await res.json(), { error: "Ese reclamo ya estaba atendido" });
        }
      });

      it("el id de un reclamo no sirve para cerrar un pendiente, ni al revés", async () => {
        const { debt } = await owed("plata");
        const claim = await recordDebtClaim({ restaurantName: "Otra", reason: "plata", closing: false, why: "x" });
        // `resolve` con el id de un reclamo apunta a un pendiente (ids distintos tablas): no cierra el reclamo.
        await act(claim.id === debt.id ? 99_998 : claim.id, { action: "resolve" });
        assert.equal((await openDebtClaims()).length, 1);
      });
    });

    describe("acciones inválidas", () => {
      for (const body of [{}, { action: "borrar" }, { action: 5 }, { action: null }]) {
        it(`${JSON.stringify(body)}: 400 «Acción inválida» y no cambia nada`, async () => {
          const { debt } = await owed("plata");
          const res = await act(debt.id, body);
          assert.equal(res.status, 400);
          assert.deepEqual(await res.json(), { error: "Acción inválida" });
          assert.equal((await getReturnDebt(debt.id))?.resolvedAt, null);
        });
      }

      it("un cuerpo que no es JSON: 400, no un error del servidor", async () => {
        const { debt } = await owed("plata");
        const res = await byId.POST(request("POST", `/api/pendientes/${debt.id}`, { raw: "no es json" }), params({ id: debt.id }));
        assert.equal(res.status, 400);
      });
    });
  });

  it("un pendiente de hace horas sigue abierto hasta que alguien lo cierre", async () => {
    const { trip, debt } = await owed("datafono");
    await setAssignment(trip.id, { assignedAt: minutesAgo(600) });
    await db.update(schema.returnDebts).set({ createdAt: minutesAgo(600) }).where(eq(schema.returnDebts.id, debt.id));
    assert.equal((await listing()).open.length, 1);
  });
});
