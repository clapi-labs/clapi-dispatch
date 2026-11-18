import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { eq, sql } from "drizzle-orm";

import { closingReminderMessage, emptyDelivery } from "@dispatch/shared";
import { db, declareReturnDebt, deliverTrip, getReturnDebt, schema } from "@dispatch/shared/db";
import { closeTestDatabase, createCourier, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  engine,
  engineCalls,
  fakeEngine,
  getAssignment,
  getTrip,
  installMocks,
  liveCourier,
  minutesAgo,
  outbox,
  pendingTrip,
  plain,
  resetMocks,
  restoreMocks,
  sentTo,
  setAssignment,
  whatsapp,
  world,
  type World,
} from "@/test-support/bot-env";

/**
 * `POST /api/internal/tick`: lo que corre el worker cada pocos segundos. Se
 * llama a la ruta tal cual (con su `Request`), contra la base de pruebas, con el
 * engine de mentiras (`fakeEngine`) y WhatsApp simulado. Se comprueba la
 * seguridad, un tick completo (asigna, avisa, recuerda y anota el latido), que
 * un engine caído o un aviso que falla no tumban el tick, y que dos ticks a la
 * vez no asignen dos veces el mismo viaje. Sin `TEST_DATABASE_URL` se salta.
 */

type Route = typeof import("./route");
type Heartbeat = typeof import("@/db/queries/worker-heartbeat");
let route: Route;
let heartbeat: Heartbeat;
const saved: Record<string, string | undefined> = {};
const SECRET = "secreto-interno-de-prueba";

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  for (const key of ["ENGINE_URL", "INTERNAL_SECRET"]) saved[key] = process.env[key];
  route = await import("./route");
  heartbeat = await import("@/db/queries/worker-heartbeat");
});

let errors: ReturnType<typeof mock.method>;

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  process.env.ENGINE_URL = "http://engine.test:3003";
  process.env.INTERNAL_SECRET = SECRET;
  // Lo que falla a propósito se anota en el log: se calla y se revisa.
  errors = mock.method(console, "error", () => {});
});

const tick = (headers: Record<string, string> = { "x-internal-secret": SECRET }) =>
  route.POST(new Request("http://bot.test/api/internal/tick", { method: "POST", headers }));
const run = async () => {
  const res = await tick();
  assert.equal(res.status, 200);
  return (await res.json()) as { assigned: number[]; reminded: number[]; alerted: number };
};

const evaluationOf = async (tripId: number) => (await db.select().from(schema.engineEvaluations).where(eq(schema.engineEvaluations.tripId, tripId)))[0];
const errorLog = () => errors.mock.calls.map((c) => c.arguments.map(String).join(" ")).join("\n");

describe("POST /api/internal/tick (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreMocks();
    await closeTestDatabase();
  });

  describe("seguridad", () => {
    async function untouched(w: World) {
      const trip = await pendingTrip(w);
      return trip;
    }

    for (const [name, headers] of [
      ["sin el secreto", {}],
      ["con un secreto vacío", { "x-internal-secret": "" }],
      ["con un secreto equivocado del mismo largo", { "x-internal-secret": SECRET.replace("secreto", "secrete") }],
      ["con un secreto más corto", { "x-internal-secret": "secreto" }],
      ["con un secreto más largo", { "x-internal-secret": `${SECRET}-extra` }],
      ["con el secreto en otro encabezado", { authorization: SECRET, "x-secret": SECRET }],
      ["con el secreto en mayúsculas", { "x-internal-secret": SECRET.toUpperCase() }],
    ] as const) {
      it(`${name}: 401 y no hace nada`, async () => {
        const w = await world({ courier: liveCourier() });
        const trip = await untouched(w);
        const res = await tick(headers as Record<string, string>);
        assert.equal(res.status, 401);
        assert.equal(await res.text(), "Unauthorized");
        assert.equal(engineCalls.length, 0, "no le pregunta al engine");
        assert.equal(outbox.length, 0, "no escribe a nadie");
        assert.equal((await getTrip(trip.id)).status, "pending");
        assert.equal(await heartbeat.lastWorkerTick(), null, "no anota el latido");
        assert.equal((await db.select().from(schema.demandState)).length, 0, "ni mide la demanda");
      });
    }

    it("con el secreto correcto responde 200 con lo que hizo", async () => {
      const res = await tick();
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { assigned: [], reminded: [], alerted: 0 });
    });

    it("solo acepta POST", () => {
      assert.equal(typeof route.POST, "function");
      assert.equal("GET" in route, false);
    });

    it("sin INTERNAL_SECRET configurado falla cerrado: lanza y no hace nada (nunca deja pasar)", async () => {
      delete process.env.INTERNAL_SECRET;
      const w = await world({ courier: liveCourier() });
      const trip = await untouched(w);
      await assert.rejects(() => tick({ "x-internal-secret": "" }), /INTERNAL_SECRET/);
      await assert.rejects(() => tick({ "x-internal-secret": "cualquiera" }), /INTERNAL_SECRET/);
      assert.equal(engineCalls.length, 0);
      assert.equal((await getTrip(trip.id)).status, "pending");
    });
  });

  describe("un tick completo", () => {
    it("asigna el pendiente, avisa al motorizado y al restaurante, y anota el latido", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      const body = await run();

      assert.deepEqual(body.assigned, [trip.id]);
      assert.equal(body.alerted, 0, "una asignación de rutina no suena en el celular: solo los bloqueos reales (#85)");
      assert.equal((await getTrip(trip.id)).status, "en_route");
      assert.equal((await getAssignment(trip.id)).courierId, w.courier.id);
      assert.equal((await db.select().from(schema.couriers).where(eq(schema.couriers.id, w.courier.id)))[0].status, "busy");
      assert.deepEqual((await evaluationOf(trip.id)).status, "decided");

      // Avisos: mensaje 1 al motorizado y «va X» al restaurante, citando su pedido.
      const [ticket] = sentTo(w.courier.phone);
      assert.match(plain(ticket.text), /Pedro, tienes un nuevo pedido P-\d+/);
      assert.deepEqual(ticket.buttons.map((b) => b.id), [`picked:${trip.id}`, `pickdebt:datafono:${trip.id}`, `pickdebt:plata:${trip.id}`]);
      const [notice] = sentTo(w.restaurantConversation.phone);
      assert.equal(notice.text, `🛵 Pedido ${trip.code}: va Pedro Gómez.`);
      assert.equal(notice.replyTo, trip.sourceWaMessageId);
      assert.equal(outbox.length, 2);

      // Latido y demanda.
      const beat = await heartbeat.lastWorkerTick();
      assert.ok(beat && Date.now() - beat.getTime() < 10_000, "anota la hora de la vuelta");
      const [demand] = await db.select().from(schema.demandState);
      assert.ok(demand.measuredAt, "midió la demanda");
      assert.equal(errors.mock.callCount(), 0, "sin errores");
    });

    it("una segunda vuelta no repite nada: ni asigna, ni avisa, ni vuelve a sonar", async () => {
      const w = await world({ courier: liveCourier() });
      await pendingTrip(w);
      await run();
      const sent = outbox.length;
      const second = await run();
      assert.deepEqual(second, { assigned: [], reminded: [], alerted: 0 });
      assert.equal(outbox.length, sent);
    });

    it("sin nada que hacer igual anota el latido (así se sabe que el worker anda)", async () => {
      assert.equal(await heartbeat.lastWorkerTick(), null);
      await run();
      const first = await heartbeat.lastWorkerTick();
      assert.ok(first);
      await new Promise((r) => setTimeout(r, 15));
      await run();
      assert.ok((await heartbeat.lastWorkerTick())!.getTime() > first.getTime(), "cada vuelta lo actualiza");
    });

    it("en la misma vuelta: recuerda lo que falta marcar y cierra la espera al cliente", async () => {
      const w = await world({ courier: liveCourier() });
      const slow = await assignedTrip(w);
      await setAssignment(slow.trip.id, { assignedAt: minutesAgo(4) });
      // Otro motorizado: con dos pedidos del mismo, el segundo no sería su primera parada y no se le recordaría.
      const waiting = await assignedTrip(w, {}, { courier: await createCourier({ name: "Luis Pérez", status: "available" }) });
      await setAssignment(waiting.trip.id, { assignedAt: minutesAgo(30), seenAt: minutesAgo(25), pickedUpAt: minutesAgo(20), customerWaitAt: minutesAgo(15) });

      const body = await run();
      assert.deepEqual(body.reminded, [slow.trip.id]);
      assert.match(sentTo(w.courier.phone).map((m) => plain(m.text)).join(" | "), /¿ya vas por el pedido/);
      assert.ok((await getAssignment(waiting.trip.id)).undeliveredAt, "se venció la espera al cliente");
      assert.match(sentTo(w.restaurantConversation.phone).map((m) => plain(m.text)).join(" | "), /el cliente no contestó en 10 minutos/);
    });

    it("en modo manual no asigna, pero lo demás sigue corriendo", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      await db.insert(schema.settings).values({ key: "engine_config", value: { mode: "manual" } });
      const slow = await assignedTrip(w);
      await setAssignment(slow.trip.id, { assignedAt: minutesAgo(4) });
      const body = await run();
      assert.deepEqual(body.assigned, []);
      assert.deepEqual(body.reminded, [slow.trip.id]);
      assert.equal((await getTrip(trip.id)).status, "pending");
      assert.equal(engineCalls.length, 0);
    });

    it("sin ENGINE_URL no asigna y no se cae", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      delete process.env.ENGINE_URL;
      const body = await run();
      assert.deepEqual(body.assigned, []);
      assert.equal((await getTrip(trip.id)).status, "pending");
      assert.ok(await heartbeat.lastWorkerTick());
    });
  });

  describe("resiliencia: si el engine falla, el tick no se cae y los viajes siguen esperando", () => {
    for (const [name, reply, reason] of [
      ["no responde", "network", /Engine: fetch failed/],
      ["se pasa del tiempo", "timeout", /Engine: The operation was aborted due to timeout/],
      ["responde 500", { http: 500, body: { error: "boom" } }, /Engine: HTTP 500: boom/],
      ["responde algo que no es JSON", "badjson", /^Engine: /],
    ] as const) {
      it(`el engine ${name}: 200, el pedido sigue pendiente con el motivo, y el latido se anota`, async () => {
        const w = await world({ courier: liveCourier() });
        const trip = await pendingTrip(w);
        const slow = await assignedTrip(w);
        await setAssignment(slow.trip.id, { assignedAt: minutesAgo(4) });
        engine.reply(reply);

        const body = await run();
        assert.deepEqual(body.assigned, []);
        assert.deepEqual(body.reminded, [slow.trip.id], "el resto del tick sigue corriendo");
        assert.equal((await getTrip(trip.id)).status, "pending");
        assert.match((await evaluationOf(trip.id)).reason ?? "", reason);
        assert.ok(await heartbeat.lastWorkerTick(), "la vuelta terminó");
        assert.match(errorLog(), /\[engine\] falló con el viaje/);
      });
    }

    it("cuando el engine vuelve, el pedido que esperaba se asigna en la siguiente vuelta", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      engine.reply("network");
      assert.deepEqual((await run()).assigned, []);
      engine.reply(null);
      assert.deepEqual((await run()).assigned, [trip.id]);
      assert.equal((await getTrip(trip.id)).status, "en_route");
    });

    it("un pedido que falla no frena al otro", async () => {
      const w = await world({ courier: liveCourier() });
      const bad = await pendingTrip(w, { createdAt: minutesAgo(5) });
      const good = await pendingTrip(w, { createdAt: minutesAgo(1) });
      engine.reply((request) => (request.pedido.id === bad.id ? "network" : fakeEngine(request)));
      assert.deepEqual((await run()).assigned, [good.id]);
      assert.equal((await getTrip(bad.id)).status, "pending");
    });

    it("sin ninguna moto con GPS, los pedidos esperan con el motivo a la vista", async () => {
      const w = await world({ courier: liveCourier({ locationUpdatedAt: minutesAgo(10) }) });
      const trip = await pendingTrip(w);
      assert.deepEqual((await run()).assigned, []);
      assert.equal((await evaluationOf(trip.id)).reason, "Sin motos elegibles (sin GPS: 1)");
    });

    /** Un trigger de prueba que hace fallar el INSERT de la evaluación con ese estado: un error de la base,
     *  que no es de red ni del engine y por eso escapa de `runEngine` hasta el `try/catch` del tick. */
    async function breakEvaluations(status: "waiting" | "decided") {
      await db.execute(sql`create or replace function test_falla_evaluacion() returns trigger as $$ begin raise exception 'la base falló'; end; $$ language plpgsql`);
      await db.execute(sql.raw(`create trigger test_falla_evaluacion before insert on engine_evaluations for each row when (new.status = '${status}') execute function test_falla_evaluacion()`));
    }
    const repairEvaluations = async () => {
      await db.execute(sql`drop trigger if exists test_falla_evaluacion on engine_evaluations`);
      await db.execute(sql`drop function if exists test_falla_evaluacion()`);
    };

    it("una falla inesperada dentro del engine (la base rechaza anotar por qué espera un pedido) tampoco tumba el tick", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      const slow = await assignedTrip(w);
      await setAssignment(slow.trip.id, { assignedAt: minutesAgo(4) });
      engine.reply((request) => ({ ...fakeEngine(request), ganador: null, plan: null }));
      await breakEvaluations("waiting");
      try {
        const body = await run();
        assert.deepEqual(body.assigned, []);
        assert.deepEqual(body.reminded, [slow.trip.id], "el resto del tick sigue");
        assert.equal((await getTrip(trip.id)).status, "pending", "el pedido sigue esperando");
        assert.ok(await heartbeat.lastWorkerTick(), "y la vuelta se anota");
        assert.match(errorLog(), /\[tick\] el engine falló:/);
      } finally {
        await repairEvaluations();
      }
    });

    // Antes, si la base fallaba al anotar la decisión (que se hace DESPUÉS de asignar), `runEngine` lanzaba y el
    // tick contestaba `assigned: []`: el viaje quedaba con moto pero nadie recibía el aviso.
    it("si la base falla al anotar la decisión, el viaje ya asignado igual se avisa", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      await breakEvaluations("decided");
      try {
        const body = await run();
        assert.equal((await getTrip(trip.id)).status, "en_route", "el viaje quedó asignado");
        assert.deepEqual(body.assigned, [trip.id], "el tick tendría que reportarlo para avisarlo");
        assert.equal(sentTo(w.courier.phone).filter((m) => /nuevo pedido/.test(m.text)).length, 1, "el motorizado recibe su mensaje 1");
      } finally {
        await repairEvaluations();
      }
    });

    it("si no se puede avisar por WhatsApp, el viaje igual queda asignado y el tick sigue", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      whatsapp.throwSends(true);
      const body = await run();
      assert.deepEqual(body.assigned, [trip.id], "la asignación ya estaba hecha");
      assert.equal((await getTrip(trip.id)).status, "en_route");
      assert.match(errorLog(), /no se pudo avisar del viaje/);
      assert.ok(await heartbeat.lastWorkerTick());
    });

    it("si WhatsApp rechaza el envío (sin lanzar), pasa lo mismo: asignado y sin caerse", async () => {
      const w = await world({ courier: liveCourier() });
      const trip = await pendingTrip(w);
      whatsapp.failSends(true);
      assert.deepEqual((await run()).assigned, [trip.id]);
      assert.equal((await getTrip(trip.id)).status, "en_route");
    });
  });

  describe("concurrencia: dos ticks a la vez no asignan dos veces el mismo viaje", () => {
    it("dos ticks, un pedido y dos motos: una sola asignación y un solo aviso", async () => {
      const w = await world({ courier: liveCourier() });
      await createCourier({ name: "Luis Pérez", ...liveCourier() });
      const trip = await pendingTrip(w);

      const [a, b] = await Promise.all([run(), run()]);
      assert.equal(a.assigned.length + b.assigned.length, 1, "lo asigna solo uno de los dos");
      assert.deepEqual([...a.assigned, ...b.assigned], [trip.id]);
      assert.equal((await db.select().from(schema.assignments).where(eq(schema.assignments.tripId, trip.id))).length, 1);
      assert.equal((await getTrip(trip.id)).status, "en_route");
      const tickets = outbox.filter((m) => /nuevo pedido/.test(m.text));
      assert.equal(tickets.length, 1, "el motorizado recibe un solo mensaje 1");
      assert.equal(outbox.filter((m) => m.phone === w.restaurantConversation.phone).length, 1, "y el restaurante un solo aviso");
    });

    // Antes, el tick que perdía la carrera sobrescribía la evaluación del pedido con «waiting: La moto elegida ya no
    // está disponible» aunque otro tick ya lo había asignado.
    it("el pedido asignado no queda anotado como «esperando» por el tick que perdió la carrera", async () => {
      const w = await world({ courier: liveCourier() });
      const luis = await createCourier({ name: "Luis Pérez", ...liveCourier() });
      const trip = await pendingTrip(w);
      // Este tick evalúa el pedido; mientras el engine «piensa», otro tick lo asigna y anota su decisión.
      engine.reply(async (request) => {
        const { assignTripTo } = await import("@dispatch/shared/db");
        assert.ok(await assignTripTo(trip.id, luis.id));
        await db.insert(schema.engineEvaluations).values({ tripId: trip.id, status: "decided", courierId: luis.id }).onConflictDoUpdate({ target: schema.engineEvaluations.tripId, set: { status: "decided", courierId: luis.id } });
        return fakeEngine(request);
      });
      const body = await run();
      assert.deepEqual(body.assigned, [], "este tick no lo asignó");
      assert.equal((await getTrip(trip.id)).status, "en_route");
      assert.equal((await db.select().from(schema.assignments).where(eq(schema.assignments.tripId, trip.id))).length, 1);
      const evaluation = await evaluationOf(trip.id);
      assert.equal(evaluation.status, "decided", `la evaluación de un pedido ya asignado dice «${evaluation.status}: ${evaluation.reason}»`);
    });

    it("tres ticks a la vez con seis pedidos: cada uno se asigna exactamente una vez", async () => {
      const w = await world({ courier: liveCourier() });
      for (const name of ["Luis", "Ana", "Eva"]) await createCourier({ name, ...liveCourier() });
      const trips = [];
      for (let i = 0; i < 6; i++) trips.push(await pendingTrip(w, { createdAt: minutesAgo(10 - i) }));

      const results = await Promise.all([run(), run(), run()]);
      const assigned = results.flatMap((r) => r.assigned);
      assert.equal(new Set(assigned).size, assigned.length, "ningún pedido lo reportan dos ticks");
      assert.deepEqual([...assigned].sort((x, y) => x - y), trips.map((t) => t.id).sort((x, y) => x - y));
      const rows = await db.select().from(schema.assignments);
      assert.equal(rows.length, 6);
      assert.equal(new Set(rows.map((r) => r.tripId)).size, 6, "una asignación por pedido");
      for (const t of trips) assert.equal((await getTrip(t.id)).status, "en_route");
      assert.equal(outbox.filter((m) => /nuevo pedido/.test(m.text)).length, 6, "un mensaje 1 por pedido, ni uno más");
    });

    it("las alertas al celular tampoco se duplican entre ticks paralelos (un chat que pide ayuda)", async () => {
      const w = await world();
      await db.update(schema.conversations).set({ botPaused: true, escalationReason: "Novedad de Pedro Gómez: Se accidentó", lastMessageAt: new Date() }).where(eq(schema.conversations.id, w.courierConversation.id));
      const results = await Promise.all([run(), run(), run()]);
      assert.equal(results.reduce((sum, r) => sum + r.alerted, 0), 1, "suena una sola vez");
      assert.equal((await run()).alerted, 0, "y no vuelve a sonar mientras siga igual");
    });

    it("un bloqueo real (el pedido lleva rato sin recogerse) suena una sola vez, en el tick que lo ve", async () => {
      const w = await world({ courier: liveCourier() });
      const { trip } = await assignedTrip(w);
      await setAssignment(trip.id, { assignedAt: minutesAgo(11), seenAt: minutesAgo(9) });
      const results = await Promise.all([run(), run()]);
      assert.equal(results.reduce((sum, r) => sum + r.alerted, 0), 1);
      assert.equal((await run()).alerted, 0);
    });
  });

  describe("el resto del tick", () => {
    /** La hora de Cali (UTC−5) dentro de `minutes` minutos, como «HH:MM». */
    const cali = (minutes: number) => {
      const d = new Date(Date.now() + minutes * 60_000 - 5 * 60 * 60_000);
      return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    };
    const hours = (deadlineIn: number) => db.insert(schema.settings).values({ key: "service_hours", value: { opensAt: cali(-120), defaultDeadline: cali(deadlineIn) } });
    /** Un restaurante con un pedido a medio armar. */
    async function halfOrder(w: World, over: Partial<typeof schema.conversations.$inferInsert> = {}, draft: Record<string, unknown> = {}) {
      await db
        .update(schema.conversations)
        .set({
          lastInboundAt: new Date(),
          draft: { etapa: "cotizado", origenRestaurante: "Pizza Nona", mensajeOrigen: "wamid.src", entregas: [{ ...emptyDelivery(), direccionEntrega: "Calle 10 # 5-20" }], ...draft },
          ...over,
        })
        .where(eq(schema.conversations.id, w.restaurantConversation.id));
    }
    const draftOf = async (w: World) => (await db.select().from(schema.conversations).where(eq(schema.conversations.id, w.restaurantConversation.id)))[0].draft as Record<string, unknown> | null;

    describe("cierre de los restaurantes (handleClosing)", () => {
      it("faltando 10 minutos o menos para su hora límite, a quien tiene un pedido a medio armar se le recuerda, una sola vez", async () => {
        const w = await world();
        await hours(5);
        await halfOrder(w);
        await run();
        const [msg] = sentTo(w.restaurantConversation.phone);
        assert.equal(msg.text, closingReminderMessage(cali(5)));
        assert.equal(msg.replyTo, "wamid.src", "cita el mensaje que abrió el pedido");
        assert.equal((await draftOf(w))?.recordatorioCierre, true);
        await run();
        assert.equal(sentTo(w.restaurantConversation.phone).length, 1, "el siguiente tick no lo repite");
      });

      it("tres ticks a la vez no lo mandan más de una vez", async () => {
        const w = await world();
        await hours(5);
        await halfOrder(w);
        await Promise.all([run(), run(), run()]);
        assert.equal(sentTo(w.restaurantConversation.phone).length, 1);
      });

      it("con más de 10 minutos por delante no se recuerda nada", async () => {
        const w = await world();
        await hours(40);
        await halfOrder(w);
        await run();
        assert.equal(outbox.length, 0);
        assert.equal((await draftOf(w))?.recordatorioCierre, undefined);
      });

      for (const [name, over, draft] of [
        ["una cotización suelta (solo preguntó el precio)", {}, { soloPrecio: true }],
        ["un chat que tiene la central al frente (bot en pausa)", { botPaused: true, escalationReason: "x" }, {}],
        ["quien escribió antes de abrir la jornada", { lastInboundAt: minutesAgo(60 * 5) }, {}],
      ] as const) {
        it(`no se le recuerda a ${name}`, async () => {
          const w = await world();
          await hours(5);
          await halfOrder(w, over as never, draft);
          await run();
          assert.equal(outbox.length, 0);
        });
      }

      it("pasada la hora límite, el pedido a medio armar se descarta y no se avisa", async () => {
        const w = await world();
        await hours(-2);
        await halfOrder(w);
        await run();
        assert.equal(await draftOf(w), null);
        assert.equal(outbox.length, 0);
      });

      it("pasada la hora límite, lo que la central tiene en su chat no se toca", async () => {
        const w = await world();
        await hours(-2);
        await halfOrder(w, { botPaused: true, escalationReason: "x" });
        await run();
        assert.ok(await draftOf(w), "se conserva el borrador para retomarlo");
      });

      it("el restaurante con su propia hora límite manda sobre la de la agencia", async () => {
        const w = await world();
        await hours(120);
        await db.update(schema.restaurants).set({ orderDeadline: cali(5) }).where(eq(schema.restaurants.id, w.restaurant.id));
        await halfOrder(w);
        await run();
        assert.equal(sentTo(w.restaurantConversation.phone).length, 1);
      });
    });

    describe("purga de posiciones de más de 24 horas", () => {
      it("borra la última posición de la moto que lleva más de 24 h sin reportar, y deja la de las demás", async () => {
        const stale = await world({ courier: { lat: 3.4, lng: -76.5, locationUpdatedAt: minutesAgo(30 * 60), locationMoving: true } });
        const live = await createCourier({ name: "Luis Pérez", ...liveCourier() });
        const thirtyHoursAgo = minutesAgo(30 * 60); // con la hora de verdad: bajo el reloj simulado `minutesAgo` daría otra
        // La purga corre cada 10 minutos, no en cada tick: se adelanta el reloj que lleva esa cuenta (no el de las posiciones).
        const base = Date.parse("2099-01-01T00:00:00Z");
        let clock = base;
        const spy = mock.method(Date, "now", () => clock);
        try {
          await run();
          const [old] = await db.select().from(schema.couriers).where(eq(schema.couriers.id, stale.courier.id));
          assert.deepEqual([old.lat, old.lng, old.locationUpdatedAt, old.locationMoving], [null, null, null, null]);
          const [fresh] = await db.select().from(schema.couriers).where(eq(schema.couriers.id, live.id));
          assert.ok(fresh.lat !== null && fresh.locationUpdatedAt, "la de una moto que reporta sigue");
          assert.equal(errors.mock.callCount(), 0);

          // Un minuto después no vuelve a purgar: otra moto con la posición vieja sigue como estaba.
          const another = await createCourier({ name: "Ana", lat: 3.4, lng: -76.5, locationUpdatedAt: thirtyHoursAgo });
          clock = base + 60_000;
          await run();
          assert.ok((await db.select().from(schema.couriers).where(eq(schema.couriers.id, another.id)))[0].lat !== null, "no se purgó antes de los 10 minutos");

          // Pasados los 10 minutos, sí.
          clock = base + 11 * 60_000;
          await run();
          assert.equal((await db.select().from(schema.couriers).where(eq(schema.couriers.id, another.id)))[0].lat, null);
        } finally {
          spy.mock.restore();
        }
      });
    });

    describe("simulador de staging (SIMULATOR_ENABLED)", () => {
      beforeEach(() => {
        process.env.SIMULATOR_ENABLED = "1";
      });
      after(() => {
        delete process.env.SIMULATOR_ENABLED;
      });

      /** Una moto simulada con un pedido ya entregado y su plata sin pagar. Con demanda alta, la plata no entra
       *  en la ruta (con demanda baja el tick le pide pasar a pagar, y esa la cierra la moto al llegar). */
      async function simulatedDebt(deliveredMinutesAgo: number) {
        await db.insert(schema.demandState).values({ id: 1, level: "alta" }).onConflictDoNothing();
        const w = await world();
        const sim = await createCourier({ name: "Moto sim 1", status: "available", simulated: true, lat: 3.45, lng: -76.53, locationUpdatedAt: new Date() });
        const { trip } = await assignedTrip(w, {}, { courier: sim });
        const { debt } = await declareReturnDebt({ courierId: sim.id, reason: "plata", restaurantName: "Pizza Nona", restaurantId: w.restaurant.id, tripId: trip.id, declaredBy: "courier" });
        await setAssignment(trip.id, { seenAt: minutesAgo(60), pickedUpAt: minutesAgo(50) });
        await deliverTrip(trip.id, { place: "customer" });
        await setAssignment(trip.id, { deliveredAt: minutesAgo(deliveredMinutesAgo) });
        return { w, sim, debt };
      }

      it("la moto simulada que se maneja sola paga la plata que lleva 30 minutos sin pagar", async () => {
        const { debt } = await simulatedDebt(31);
        await run();
        const closed = await getReturnDebt(debt.id);
        assert.ok(closed?.resolvedAt);
        assert.equal(closed?.resolvedBy, "courier");
      });

      it("antes de los 30 minutos no", async () => {
        const { debt } = await simulatedDebt(5);
        await run();
        assert.equal((await getReturnDebt(debt.id))?.resolvedAt, null);
      });

      it("una moto que controla un número de prueba no: eso lo hace la persona", async () => {
        const { sim, debt } = await simulatedDebt(31);
        const tester = await createCourier({ name: "Probador", status: "available" });
        await db.insert(schema.simulatorControls).values({ phoneCourierId: tester.id, simCourierId: sim.id });
        await run();
        assert.equal((await getReturnDebt(debt.id))?.resolvedAt, null);
      });

      it("con el simulador apagado no cierra nada", async () => {
        const { debt } = await simulatedDebt(31);
        delete process.env.SIMULATOR_ENABLED;
        await run();
        assert.equal((await getReturnDebt(debt.id))?.resolvedAt, null);
      });

      it("el número de prueba cuya moto ya no tiene pedidos queda libre", async () => {
        const w = await world();
        const sim = await createCourier({ name: "Moto sim 2", status: "available", simulated: true });
        const tester = await createCourier({ name: "Probador", status: "available" });
        await db.insert(schema.simulatorControls).values({ phoneCourierId: tester.id, simCourierId: sim.id });
        const { trip } = await assignedTrip(w, {}, { courier: sim });
        await setAssignment(trip.id, { assignedAt: minutesAgo(10) });
        await run();
        const [still] = await db.select().from(schema.simulatorControls);
        assert.equal(still.simCourierId, sim.id, "con un pedido abierto la sigue controlando");
        await setAssignment(trip.id, { seenAt: minutesAgo(8), pickedUpAt: minutesAgo(5), deliveredAt: minutesAgo(2), finishedAt: minutesAgo(2) });
        await db.update(schema.trips).set({ status: "delivered" }).where(eq(schema.trips.id, trip.id));
        await run();
        const [released] = await db.select().from(schema.simulatorControls);
        assert.equal(released.simCourierId, null, "sin pedidos y pasado el margen, queda libre");
      });
    });
  });
});
