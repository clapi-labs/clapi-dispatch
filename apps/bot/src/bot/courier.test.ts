import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { completeCourierOnboarding, declareReturnDebt, db, getReturnDebt, openReturnDebts, schema } from "@dispatch/shared/db";
import { closeTestDatabase, createConversation, createCourier, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  buttonFrom,
  classified,
  classifier,
  getAssignment,
  getConversation,
  getCourier,
  getTrip,
  installMocks,
  minutesAgo,
  outbox,
  plain,
  resetMocks,
  restoreMocks,
  sentTo,
  setAssignment,
  textFrom,
  whatsapp,
  world,
  type World,
} from "@/test-support/bot-env";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * El flujo del motorizado (`courier.ts`) de punta a punta: sus botones, lo que
 * escribe en vez de tocarlos, las novedades que pasan a la central y qué pasa
 * cuando OpenAI cae. WhatsApp y OpenAI son simulados (`test-support/bot-env.ts`);
 * el viaje, la asignación, el motorizado, los pendientes y la conversación son
 * los de verdad, en el Postgres de pruebas (docs/OPERACION.md, «Pruebas de
 * integración»). Sin `TEST_DATABASE_URL` se salta.
 */

type Courier = typeof import("./courier");
type Notify = typeof import("./notify");
let courier: Courier;
let notify: Notify;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  courier = await import("./courier");
  notify = await import("./notify");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  delete process.env.SIMULATOR_ENABLED;
});

/** Lo que hace `intake.ts`: busca al motorizado y su conversación y le pasa el mensaje. */
async function act(w: World, message: IncomingMessage) {
  const found = await courier.findCourier(w.courier.phone);
  assert.ok(found, "el motorizado existe y está activo");
  await courier.handleCourier(found, await getConversation(w.courierConversation.id), message);
}
const tap = (w: World, id: string) => act(w, buttonFrom(w.courier.phone, id));
const write = (w: World, text: string) => act(w, textFrom(w.courier.phone, text));

/** Un pedido asignado y con su mensaje 1 ya enviado, como llega de verdad. */
async function ticketed(w: World, over: Parameters<typeof assignedTrip>[1] = {}, who?: Parameters<typeof assignedTrip>[2]) {
  const t = await assignedTrip(w, over, who);
  await notify.notifyAssigned(t.trip.id);
  outbox.length = 0;
  return t;
}

/** Lo avanza hasta que lleva el pedido (como si hubiera tocado «Recogí»). */
const pickedUp = (tripId: number) => setAssignment(tripId, { seenAt: minutesAgo(8), pickedUpAt: minutesAgo(2) });

const toCourier = (w: World) => sentTo(w.courier.phone);
const toRestaurant = (w: World) => sentTo(w.restaurantConversation.phone);

describe("courier.ts: flujo del motorizado (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("botones", () => {
    describe("«Voy en camino» (going)", () => {
      it("guarda la hora una sola vez y, por defecto, no responde (el «Recogí» ya va en el mismo mensaje)", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, `going:${trip.id}`);
        const first = (await getAssignment(trip.id)).seenAt;
        assert.ok(first, "queda la hora en que salió");
        assert.equal(outbox.length, 0);
        // Un doble toque no cambia la hora.
        await new Promise((r) => setTimeout(r, 15));
        await tap(w, `going:${trip.id}`);
        assert.equal((await getAssignment(trip.id)).seenAt?.getTime(), first.getTime());
      });

      it("el botón de la ficha anterior (seen:) sí recibe el «Recogí» aparte, porque no lo traía", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, `seen:${trip.id}`);
        assert.ok((await getAssignment(trip.id)).seenAt);
        const [reply] = toCourier(w);
        assert.match(plain(reply.text), new RegExp(`Listo 👍 Toca «Recogí» cuando tengas el pedido ${trip.code}`));
        assert.deepEqual(reply.buttons.map((b) => b.id), [`picked:${trip.id}`, `pickdebt:datafono:${trip.id}`, `pickdebt:plata:${trip.id}`]);
      });

      it("si la agencia lo pidió (pickupButtonAfterGoing), también responde con «Recogí»", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await db.insert(schema.settings).values({ key: "bot_config", value: { pickupButtonAfterGoing: true } });
        await tap(w, `going:${trip.id}`);
        assert.equal(toCourier(w).length, 1);
        assert.match(plain(toCourier(w)[0].text), /Toca «Recogí»/);
      });

      it("cita el mensaje 1 de ese pedido al responder", async () => {
        const w = await world();
        const { trip } = await assignedTrip(w);
        await notify.notifyAssigned(trip.id);
        const ticket = toCourier(w)[0];
        outbox.length = 0;
        await tap(w, `seen:${trip.id}`);
        assert.equal(toCourier(w)[0].replyTo, ticket.wamid);
      });
    });

    describe("«Recogí» (picked)", () => {
      it("marca la recogida y manda el mensaje 2 con los botones de entrega, citando el 1", async () => {
        const w = await world();
        const { trip } = await assignedTrip(w);
        await notify.notifyAssigned(trip.id);
        const ticket = toCourier(w)[0];
        outbox.length = 0;
        await tap(w, `picked:${trip.id}`);
        assert.ok((await getAssignment(trip.id)).pickedUpAt);
        const [reply] = toCourier(w);
        assert.match(plain(reply.text), new RegExp(`Perfecto, ahora lleva el pedido ${trip.code}`));
        assert.match(plain(reply.text), /\*Entrega en:\* Calle 10 # 5-20 · Torre 2 apto 301/);
        assert.deepEqual(reply.buttons.map((b) => b.id), [`done:customer:finish:${trip.id}`, `done:gate:finish:${trip.id}`, `noanswer:${trip.id}`]);
        assert.equal(reply.replyTo, ticket.wamid);
        assert.equal(toRestaurant(w).length, 0, "al restaurante no se le dice nada al recoger");
      });

      it("un doble toque no manda el mensaje 2 otra vez ni cambia la hora", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, `picked:${trip.id}`);
        const at = (await getAssignment(trip.id)).pickedUpAt;
        outbox.length = 0;
        await tap(w, `picked:${trip.id}`);
        assert.equal(outbox.length, 0);
        assert.equal((await getAssignment(trip.id)).pickedUpAt?.getTime(), at?.getTime());
      });

      it("«Llevo datáfono» recoge y deja anotado el pendiente de ese restaurante", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, `pickdebt:datafono:${trip.id}`);
        assert.ok((await getAssignment(trip.id)).pickedUpAt, "cuenta como «Recogí»");
        const [debt] = await openReturnDebts(w.courier.id);
        assert.equal(debt.reason, "datafono");
        assert.equal(debt.tripId, trip.id);
        assert.equal(debt.restaurantName, "Pizza Nona");
        assert.equal(debt.declaredBy, "courier");
        assert.match(plain(toCourier(w)[0].text), /Perfecto, ahora lleva el pedido/);
      });

      it("«Quedé debiendo» recoge y anota la plata", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, `pickdebt:plata:${trip.id}`);
        const [debt] = await openReturnDebts(w.courier.id);
        assert.equal(debt.reason, "plata");
        assert.ok((await getAssignment(trip.id)).pickedUpAt);
      });

      it("declarar el pendiente con el pedido ya recogido (GPS o botón anterior): lo confirma sin repetir el mensaje 2", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `pickdebt:datafono:${trip.id}`);
        assert.equal((await openReturnDebts(w.courier.id)).length, 1);
        assert.match(plain(toCourier(w)[0].text), /Anotado 👍 Quedó registrado que llevas el datáfono de Pizza Nona\. Al entregar te recuerdo\./);
        assert.ok(!/Perfecto, ahora lleva/.test(toCourier(w)[0].text));
      });

      it("el doble toque de un pendiente ya anotado no crea otro ni responde", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `pickdebt:datafono:${trip.id}`);
        outbox.length = 0;
        await tap(w, `pickdebt:datafono:${trip.id}`);
        assert.equal((await openReturnDebts(w.courier.id)).length, 1);
        assert.equal(outbox.length, 0);
      });

      it("un botón de pendiente con un motivo que no existe se ignora", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, `pickdebt:propina:${trip.id}`);
        assert.equal((await openReturnDebts(w.courier.id)).length, 0);
        assert.equal((await getAssignment(trip.id)).pickedUpAt, null);
      });
    });

    describe("entrega (delivered)", () => {
      it("en el cliente: el viaje queda entregado, la moto libre, y el restaurante y el motorizado reciben su aviso", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `done:customer:finish:${trip.id}`);
        assert.equal((await getTrip(trip.id)).status, "delivered");
        const a = await getAssignment(trip.id);
        assert.equal(a.deliveryPlace, "customer");
        assert.ok(a.deliveredAt && a.finishedAt);
        assert.equal((await getCourier(w.courier.id)).status, "available");
        assert.match(plain(toCourier(w)[0].text), new RegExp(`✅ ${trip.code} terminado\\.`));
        assert.match(plain(toRestaurant(w)[0].text), new RegExp(`Pedido ${trip.code} entregado a las`));
        assert.equal(toRestaurant(w)[0].replyTo, trip.sourceWaMessageId, "cita el pedido del restaurante");
      });

      it("en portería: el restaurante recibe a quién avisarle (nombre y apartamento)", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `done:gate:finish:${trip.id}`);
        assert.equal((await getAssignment(trip.id)).deliveryPlace, "gate");
        const text = plain(toRestaurant(w)[0].text);
        assert.match(text, new RegExp(`Pedido ${trip.code} quedó en portería a las`));
        assert.match(text, /Para Marta Ríos, Torre 2 apto 301\. Ya puedes avisarle al cliente\./);
      });

      it("el botón de la ficha anterior (deliver:) entrega al cliente", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `deliver:${trip.id}`);
        assert.equal((await getAssignment(trip.id)).deliveryPlace, "customer");
      });

      it("las opciones viejas con «vuelvo» (done:…:return:) solo marcan la entrega", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `done:gate:return:${trip.id}`);
        assert.equal((await getTrip(trip.id)).status, "delivered");
        assert.equal((await getAssignment(trip.id)).deliveryPlace, "gate");
      });

      it("un doble toque no entrega dos veces ni repite los avisos", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `done:customer:finish:${trip.id}`);
        const sent = outbox.length;
        const at = (await getAssignment(trip.id)).deliveredAt;
        await tap(w, `done:gate:finish:${trip.id}`);
        assert.equal(outbox.length, sent);
        const a = await getAssignment(trip.id);
        assert.equal(a.deliveryPlace, "customer", "no cambia el lugar");
        assert.equal(a.deliveredAt?.getTime(), at?.getTime());
      });

      it("con otro pedido encima, la moto sigue ocupada", async () => {
        const w = await world();
        const first = await ticketed(w);
        await ticketed(w);
        await pickedUp(first.trip.id);
        await tap(w, `done:customer:finish:${first.trip.id}`);
        assert.equal((await getCourier(w.courier.id)).status, "busy");
      });

      it("si declaró un datáfono con ese pedido, al entregar recibe cómo cerrarlo, con su botón", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, `pickdebt:datafono:${trip.id}`);
        outbox.length = 0;
        await tap(w, `done:customer:finish:${trip.id}`);
        const [msg] = toCourier(w);
        assert.match(plain(msg.text), new RegExp(`✅ ${trip.code} terminado\\.`));
        assert.match(plain(msg.text), /Devuelve el datáfono en Pizza Nona/);
        const [debt] = await openReturnDebts(w.courier.id);
        assert.deepEqual(msg.buttons.map((b) => b.id), [`debtok:${debt.id}`]);
        assert.ok(debt.reminderAt, "queda registrado que se le avisó");
      });

      it("si WhatsApp rechaza el envío, la entrega igual queda guardada", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        whatsapp.failSends(true);
        await tap(w, `done:customer:finish:${trip.id}`);
        assert.equal((await getTrip(trip.id)).status, "delivered");
      });
    });

    describe("el cliente no contesta (no_answer)", () => {
      it("empieza la espera, le dice al motorizado cuánto esperar y le avisa al restaurante con los datos del cliente", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `noanswer:${trip.id}`);
        assert.ok((await getAssignment(trip.id)).customerWaitAt);
        const [mine] = toCourier(w);
        assert.match(plain(mine.text), /Ya le avisamos al restaurante\. Espera hasta 10 minutos y, si el cliente sale, marca la entrega\./);
        assert.deepEqual(mine.buttons.map((b) => b.id), [`done:customer:finish:${trip.id}`, `done:gate:finish:${trip.id}`], "sin «Cliente no contesta» mientras espera");
        const [theirs] = toRestaurant(w);
        assert.match(plain(theirs.text), new RegExp(`Pedido ${trip.code}: el cliente no contesta \\(Marta Ríos · 300 123 4567\\)\\. El domiciliario lo espera hasta 10 minutos\\. ¿Puedes contactarlo\\?`));
        assert.equal(theirs.replyTo, trip.sourceWaMessageId);
      });

      it("un doble toque no reinicia la espera ni repite los avisos", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `noanswer:${trip.id}`);
        const at = (await getAssignment(trip.id)).customerWaitAt;
        outbox.length = 0;
        await tap(w, `noanswer:${trip.id}`);
        assert.equal(outbox.length, 0);
        assert.equal((await getAssignment(trip.id)).customerWaitAt?.getTime(), at?.getTime());
      });

      it("si el cliente sale, el motorizado marca la entrega y esa entrega sí se cierra", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `noanswer:${trip.id}`);
        await tap(w, `done:customer:finish:${trip.id}`);
        assert.equal((await getTrip(trip.id)).status, "delivered");
      });
    });

    describe("devolvió el pedido (returned)", () => {
      it("cierra el viaje sin entregar, libera la moto y se lo confirma", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await setAssignment(trip.id, { customerWaitAt: minutesAgo(12), undeliveredAt: minutesAgo(1) });
        await tap(w, `returned:${trip.id}`);
        assert.equal((await getTrip(trip.id)).status, "cancelled");
        assert.ok((await getAssignment(trip.id)).finishedAt);
        assert.equal((await getCourier(w.courier.id)).status, "available");
        assert.match(plain(toCourier(w)[0].text), new RegExp(`✅ ${trip.code} devuelto\\.`));
      });

      it("un doble toque no vuelve a cerrar ni a confirmar: el viaje ya cancelado deja de ser suyo", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await tap(w, `returned:${trip.id}`);
        assert.equal(toCourier(w).length, 1);
        const finished = (await getAssignment(trip.id)).finishedAt;
        await tap(w, `returned:${trip.id}`);
        // No repite «devuelto»: la segunda vez el viaje ya está cancelado y se le dice que ya no es suyo.
        assert.equal(toCourier(w).length, 2);
        assert.equal(plain(toCourier(w)[1].text), "Ese servicio ya no está a tu nombre 🙏");
        assert.equal((await getAssignment(trip.id)).finishedAt?.getTime(), finished?.getTime());
        assert.equal((await getTrip(trip.id)).status, "cancelled");
      });
    });

    describe("cerrar un pendiente (debt_done)", () => {
      async function openDebt(w: World, reason: "datafono" | "plata", delivered = true) {
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        const { debt } = await declareReturnDebt({ courierId: w.courier.id, reason, restaurantName: "Pizza Nona", restaurantId: w.restaurant.id, tripId: trip.id, declaredBy: "courier" });
        if (delivered) await tap(w, `done:customer:finish:${trip.id}`);
        outbox.length = 0;
        return { trip, debt };
      }

      it("«Ya lo devolví»: cierra el datáfono y se lo confirma", async () => {
        const w = await world();
        const { debt } = await openDebt(w, "datafono");
        await tap(w, `debtok:${debt.id}`);
        const closed = await getReturnDebt(debt.id);
        assert.ok(closed?.resolvedAt);
        assert.equal(closed?.resolvedBy, "courier");
        assert.equal(toCourier(w).length, 1);
        assert.match(plain(toCourier(w)[0].text), /Pizza Nona/);
      });

      it("«Ya pagué»: cierra la plata de ese restaurante", async () => {
        const w = await world();
        const { debt } = await openDebt(w, "plata");
        await tap(w, `debtok:${debt.id}`);
        assert.ok((await getReturnDebt(debt.id))?.resolvedAt);
      });

      it("un pendiente ya cerrado: no responde ni lo cambia", async () => {
        const w = await world();
        const { debt } = await openDebt(w, "plata");
        await tap(w, `debtok:${debt.id}`);
        const at = (await getReturnDebt(debt.id))?.resolvedAt;
        outbox.length = 0;
        await tap(w, `debtok:${debt.id}`);
        assert.equal(outbox.length, 0);
        assert.equal((await getReturnDebt(debt.id))?.resolvedAt?.getTime(), at?.getTime());
      });

      it("un pendiente de otro motorizado no se toca", async () => {
        const w = await world();
        const { debt } = await openDebt(w, "plata");
        const other = await createCourier({ name: "Luis", status: "available" });
        const otherConversation = await createConversation({ phone: other.phone });
        const found = await courier.findCourier(other.phone);
        await courier.handleCourier(found!, otherConversation, buttonFrom(other.phone, `debtok:${debt.id}`));
        assert.equal((await getReturnDebt(debt.id))?.resolvedAt, null);
        assert.equal(outbox.length, 0);
      });

      it("un datáfono cuyo pedido todavía no se entrega no se puede cerrar: sigue abierto y no dice nada", async () => {
        const w = await world();
        const { debt } = await openDebt(w, "datafono", false);
        await tap(w, `debtok:${debt.id}`);
        assert.equal((await getReturnDebt(debt.id))?.resolvedAt, null);
        assert.equal(outbox.length, 0);
      });

      it("el «Ya volví» de antes de los pendientes (back:) no hace nada", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, `back:${trip.id}`);
        assert.equal(outbox.length, 0);
        assert.equal((await getTrip(trip.id)).status, "en_route");
      });
    });

    describe("botones viejos y de viajes que ya no son suyos", () => {
      const ids = (tripId: number) => [`going:${tripId}`, `seen:${tripId}`, `picked:${tripId}`, `pickdebt:datafono:${tripId}`, `done:customer:finish:${tripId}`, `deliver:${tripId}`, `noanswer:${tripId}`, `returned:${tripId}`];

      it("de un viaje que le pasaron a otra moto: «Ese servicio ya no está a tu nombre» y no cambia nada", async () => {
        const w = await world();
        const other = await createCourier({ name: "Luis", status: "available" });
        const { trip } = await assignedTrip(w, {}, { courier: other });
        for (const id of ids(trip.id)) {
          outbox.length = 0;
          await tap(w, id);
          assert.equal(toCourier(w).length, 1, id);
          assert.equal(plain(toCourier(w)[0].text), "Ese servicio ya no está a tu nombre 🙏", id);
        }
        const a = await getAssignment(trip.id);
        assert.deepEqual([a.seenAt, a.pickedUpAt, a.deliveredAt, a.customerWaitAt], [null, null, null, null], "ningún toque lo movió");
        assert.equal((await getTrip(trip.id)).status, "en_route");
        assert.equal((await openReturnDebts()).length, 0);
      });

      it("de un viaje cancelado", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await db.update(schema.trips).set({ status: "cancelled" }).where(eq(schema.trips.id, trip.id));
        await tap(w, `picked:${trip.id}`);
        assert.equal(plain(toCourier(w)[0].text), "Ese servicio ya no está a tu nombre 🙏");
        assert.equal((await getAssignment(trip.id)).pickedUpAt, null);
      });

      it("de un viaje que no existe", async () => {
        const w = await world();
        await tap(w, "picked:99999");
        assert.equal(plain(toCourier(w)[0].text), "Ese servicio ya no está a tu nombre 🙏");
      });

      it("un botón que no es del flujo del motorizado no cambia nada", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await tap(w, "confirmar");
        assert.equal(outbox.length, 0);
        assert.equal((await getTrip(trip.id)).status, "en_route");
      });
    });
  });

  describe("texto libre equivalente a los botones", () => {
    describe("«ok» / «voy»", () => {
      it("con un pedido sin confirmar cuenta como «Voy en camino» y no pasa por OpenAI", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await write(w, "ok");
        assert.ok((await getAssignment(trip.id)).seenAt);
        assert.equal(classified.length, 0);
        assert.equal(outbox.length, 0);
      });

      for (const said of ["Voy", "ya voy", "Dale 👍", "Recibido", "listo"]) {
        it(`«${said}» también`, async () => {
          const w = await world();
          const { trip } = await ticketed(w);
          await write(w, said);
          assert.ok((await getAssignment(trip.id)).seenAt);
        });
      }

      it("con varios sin confirmar, el más viejo primero", async () => {
        const w = await world();
        const older = await ticketed(w);
        await new Promise((r) => setTimeout(r, 15));
        const newer = await ticketed(w);
        await write(w, "ok");
        assert.ok((await getAssignment(older.trip.id)).seenAt);
        assert.equal((await getAssignment(newer.trip.id)).seenAt, null);
        await write(w, "ok");
        assert.ok((await getAssignment(newer.trip.id)).seenAt, "el segundo «ok» confirma el siguiente");
      });

      it("con todo ya confirmado, un «ok» no cambia nada (se clasifica como «otro»)", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await setAssignment(trip.id, { seenAt: minutesAgo(3) });
        classifier.next({ tipo: "otro" });
        await write(w, "ok");
        assert.equal(outbox.length, 0);
        assert.equal((await getCourier(w.courier.id)).status, "busy");
      });
    });

    describe("«ya recogí»", () => {
      it("con un solo pedido por recoger: lo recoge y manda el mensaje 2, sin pasar por OpenAI", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await write(w, "Ya recogí");
        assert.ok((await getAssignment(trip.id)).pickedUpAt);
        assert.match(plain(toCourier(w)[0].text), /Perfecto, ahora lleva el pedido/);
        assert.equal(classified.length, 0);
      });

      it("con dos por recoger no adivina cuál: nada cambia y se clasifica (queda para la central)", async () => {
        const w = await world();
        const a = await ticketed(w);
        const b = await ticketed(w);
        classifier.next({ tipo: "otro" });
        await write(w, "ya recogí");
        assert.equal((await getAssignment(a.trip.id)).pickedUpAt, null);
        assert.equal((await getAssignment(b.trip.id)).pickedUpAt, null);
        assert.deepEqual(classified, ["ya recogí"]);
      });

      it("sobre un pedido que ya llevaba no aplica", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        const at = (await getAssignment(trip.id)).pickedUpAt;
        classifier.next({ tipo: "otro" });
        await write(w, "ya recogí");
        assert.equal((await getAssignment(trip.id)).pickedUpAt?.getTime(), at?.getTime());
        assert.equal(outbox.length, 0);
      });
    });

    describe("«entregué» / «en portería»", () => {
      it("«Entregué» entrega al cliente", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await write(w, "Entregué");
        assert.equal((await getAssignment(trip.id)).deliveryPlace, "customer");
        assert.equal((await getTrip(trip.id)).status, "delivered");
        assert.equal(classified.length, 0);
      });

      for (const said of ["en portería", "Lo dejé en portería", "ya entregué en la portería", "Entregado en portería."]) {
        it(`«${said}» entrega en portería`, async () => {
          const w = await world();
          const { trip } = await ticketed(w);
          await pickedUp(trip.id);
          await write(w, said);
          assert.equal((await getAssignment(trip.id)).deliveryPlace, "gate");
          assert.match(plain(toRestaurant(w)[0].text), /quedó en portería/);
        });
      }

      it("con dos pedidos encima no adivina cuál: se clasifica", async () => {
        const w = await world();
        const a = await ticketed(w);
        const b = await ticketed(w);
        await pickedUp(a.trip.id);
        await pickedUp(b.trip.id);
        classifier.next({ tipo: "otro" });
        await write(w, "entregué");
        assert.equal((await getTrip(a.trip.id)).status, "en_route");
        assert.equal((await getTrip(b.trip.id)).status, "en_route");
        assert.equal(classified.length, 1);
      });

      it("«no lo entregué» no es una entrega: pasa a la clasificación", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        classifier.next({ tipo: "novedad", resumen: "No pudo entregar" });
        await write(w, "no lo entregué");
        assert.equal((await getTrip(trip.id)).status, "en_route");
        assert.equal((await getCourier(w.courier.id)).status, "paused");
      });
    });

    describe("«cliente no contesta» y «devolví el pedido»", () => {
      it("con el pedido en la mano empieza la espera", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await write(w, "El cliente no contesta");
        assert.ok((await getAssignment(trip.id)).customerWaitAt);
        assert.equal(classified.length, 0);
        assert.equal(toRestaurant(w).length, 1);
      });

      it("sin el pedido en la mano no hay a quién esperar: se clasifica", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        classifier.next({ tipo: "otro" });
        await write(w, "cliente no contesta");
        assert.equal((await getAssignment(trip.id)).customerWaitAt, null);
        assert.equal(classified.length, 1);
      });

      it("«ya devolví el pedido» cierra el servicio cuando venció la espera", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await setAssignment(trip.id, { customerWaitAt: minutesAgo(12), undeliveredAt: minutesAgo(1) });
        await write(w, "ya devolví el pedido");
        assert.equal((await getTrip(trip.id)).status, "cancelled");
        assert.match(plain(toCourier(w)[0].text), /devuelto\./);
      });

      it("«devolví el pedido» sin que haya vencido la espera no aplica", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        classifier.next({ tipo: "otro" });
        await write(w, "devolví el pedido");
        assert.equal((await getTrip(trip.id)).status, "en_route");
      });
    });

    describe("«desactivado»", () => {
      it("sin pedidos: queda desconectado", async () => {
        const w = await world();
        await write(w, "Desactivado");
        assert.equal((await getCourier(w.courier.id)).status, "offline");
        assert.equal(plain(toCourier(w)[0].text), "Quedaste desconectado. Para volver escribe hola.");
        assert.equal(classified.length, 0);
      });

      for (const said of ["desactivado.", "DESACTIVADO 👍", "me desactivo", "Desactivada"]) {
        it(`«${said}» es lo mismo`, async () => {
          const w = await world();
          await write(w, said);
          assert.equal((await getCourier(w.courier.id)).status, "offline");
          assert.equal(classified.length, 0);
        });
      }

      it("una frase que solo contiene la palabra no desconecta: pasa a la clasificación", async () => {
        const w = await world();
        classifier.next({ tipo: "otro" });
        await write(w, "me desactivaron la cuenta, qué hago");
        assert.equal((await getCourier(w.courier.id)).status, "available");
        assert.equal(classified.length, 1);
      });

      it("con un pedido activo se bloquea y se le dice que termine primero", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await write(w, "desactivado");
        assert.equal((await getCourier(w.courier.id)).status, "busy", "no se desconecta");
        assert.equal(plain(toCourier(w)[0].text), "Termina primero lo que llevas y vuelve a escribir desactivado.");
        assert.equal((await getTrip(trip.id)).status, "en_route");
      });

      it("con el pedido ya entregado sí puede desconectarse", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await write(w, "entregué");
        outbox.length = 0;
        await write(w, "desactivado");
        assert.equal((await getCourier(w.courier.id)).status, "offline");
      });

      it("ya desconectado: se le dice, y no lo conecta", async () => {
        const w = await world({ courier: { status: "offline" } });
        await write(w, "desactivado");
        assert.equal((await getCourier(w.courier.id)).status, "offline");
        assert.equal(plain(toCourier(w)[0].text), "Ya estabas desconectado. Para volver escribe hola.");
      });

      it("en pausa (la pone y la quita la central): no responde ni cambia nada", async () => {
        const w = await world({ courier: { status: "paused" } });
        await write(w, "desactivado");
        assert.equal((await getCourier(w.courier.id)).status, "paused");
        assert.equal(outbox.length, 0);
      });
    });

    describe("«llevo datáfono» / «quedé debiendo»", () => {
      it("«llevo datáfono» con un pedido por recoger: recoge, anota el pendiente y manda el mensaje 2", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await write(w, "Recogí, llevo datáfono");
        assert.ok((await getAssignment(trip.id)).pickedUpAt);
        const [debt] = await openReturnDebts(w.courier.id);
        assert.deepEqual([debt.reason, debt.tripId, debt.restaurantName], ["datafono", trip.id, "Pizza Nona"]);
        assert.match(plain(toCourier(w)[0].text), /Perfecto, ahora lleva el pedido/);
        assert.equal(classified.length, 0);
      });

      it("«quedé debiendo» con el pedido ya recogido: anota la plata y lo confirma", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await write(w, "quedé debiendo");
        const [debt] = await openReturnDebts(w.courier.id);
        assert.equal(debt.reason, "plata");
        assert.match(plain(toCourier(w)[0].text), /Anotado 👍 Quedó registrado que le quedaste debiendo de Pizza Nona\. Al entregar te recuerdo\./);
      });

      it("nombrando el restaurante entre varios pedidos: usa ese", async () => {
        const w = await world();
        await ticketed(w);
        const lucho = await world({ restaurantName: "Donde Lucho" });
        // El segundo restaurante, con un pedido de la misma moto.
        const second = await assignedTrip(lucho, {}, { courier: w.courier });
        await notify.notifyAssigned(second.trip.id);
        outbox.length = 0;
        await write(w, "llevo datáfono de Donde Lucho");
        const [debt] = await openReturnDebts(w.courier.id);
        assert.equal(debt.restaurantName, "Donde Lucho");
        assert.equal(debt.tripId, second.trip.id);
      });

      it("con pedidos de varios restaurantes y sin nombre: pregunta de cuál, sin adivinar", async () => {
        const w = await world();
        await ticketed(w);
        const lucho = await world({ restaurantName: "Donde Lucho" });
        await assignedTrip(lucho, {}, { courier: w.courier });
        await write(w, "llevo datáfono");
        assert.equal((await openReturnDebts(w.courier.id)).length, 0);
        assert.match(plain(toCourier(w)[0].text), /¿De cuál restaurante\? Escríbeme por ejemplo «llevo datáfono de /);
      });

      it("sin ningún pedido de hoy: manda a escribirle a la central", async () => {
        const w = await world();
        await write(w, "llevo datáfono");
        assert.match(plain(toCourier(w)[0].text), /No encuentro un pedido tuyo de hoy para anotarlo\. Escríbele a la central/);
      });

      it("si ya estaba anotado, lo dice (porque lo escribió)", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await write(w, "llevo datáfono");
        outbox.length = 0;
        await write(w, "llevo datáfono");
        assert.equal((await openReturnDebts(w.courier.id)).length, 1);
        assert.match(plain(toCourier(w)[0].text), /Ya estaba anotado 👍 El datáfono de Pizza Nona sigue pendiente\./);
      });

      it("«no llevo datáfono» no es una declaración", async () => {
        const w = await world();
        await ticketed(w);
        classifier.next({ tipo: "otro" });
        await write(w, "no llevo datáfono");
        assert.equal((await openReturnDebts(w.courier.id)).length, 0);
      });

      it("«ya devolví el datáfono» cierra el pendiente de un pedido ya entregado", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await write(w, "Recogí, llevo datáfono");
        await write(w, "entregué");
        outbox.length = 0;
        await write(w, "ya devolví el datáfono");
        const [closed] = (await db.select().from(schema.returnDebts).where(eq(schema.returnDebts.tripId, trip.id)));
        assert.ok(closed.resolvedAt);
        assert.equal(closed.resolvedBy, "courier");
        assert.match(plain(toCourier(w)[0].text), /Pizza Nona/);
      });

      it("«ya devolví el datáfono» con el pedido todavía en la calle: explica que va con un pedido sin entregar", async () => {
        const w = await world();
        await ticketed(w);
        await write(w, "Recogí, llevo datáfono");
        outbox.length = 0;
        await write(w, "ya devolví el datáfono");
        assert.equal((await openReturnDebts(w.courier.id)).length, 1);
        assert.match(plain(toCourier(w)[0].text), /Ese datáfono todavía va con un pedido sin entregar/);
      });

      it("«ya le pagué a Pizza Nona» cierra la plata", async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        await pickedUp(trip.id);
        await write(w, "quedé debiendo");
        await write(w, "entregué");
        await write(w, "ya le pagué a Pizza Nona");
        assert.equal((await openReturnDebts(w.courier.id)).length, 0);
      });

      it("cerrar sin nada anotado: se lo dice", async () => {
        const w = await world();
        await write(w, "ya devolví el datáfono");
        assert.equal(plain(toCourier(w)[0].text), "No tienes datáfonos anotados por devolver 👍");
        outbox.length = 0;
        await write(w, "ya le pagué a Pizza Nona");
        assert.equal(plain(toCourier(w)[0].text), "No tienes nada anotado por pagar 👍");
      });
    });
  });

  describe("escalado de novedades a la central", () => {
    it("pausa a la moto, pausa el chat y deja el motivo con los códigos de sus viajes; lo que lleva se conserva", async () => {
      const w = await world();
      const first = await ticketed(w);
      const second = await ticketed(w);
      classifier.next({ tipo: "novedad", resumen: "Se accidentó" });
      await write(w, "me caí con la moto");

      assert.equal((await getCourier(w.courier.id)).status, "paused");
      const conversation = await getConversation(w.courierConversation.id);
      assert.equal(conversation.botPaused, true);
      assert.equal(conversation.escalationReason, `Novedad de Pedro Gómez (${second.trip.code}, ${first.trip.code}): Se accidentó`);
      assert.equal(plain(toCourier(w)[0].text), "Recibido 🙏 La central ya te contacta.");
      assert.equal(toCourier(w)[0].replyTo, null);
      // Conserva lo que lleva: nada se devuelve ni se cancela.
      assert.equal((await getTrip(first.trip.id)).status, "en_route");
      assert.equal((await getTrip(second.trip.id)).status, "en_route");
      assert.ok(await getAssignment(first.trip.id));
    });

    it("sin pedidos encima, el motivo no lleva códigos", async () => {
      const w = await world();
      classifier.next({ tipo: "novedad", resumen: "Se varó la moto" });
      await write(w, "se varó");
      const conversation = await getConversation(w.courierConversation.id);
      assert.equal(conversation.escalationReason, "Novedad de Pedro Gómez: Se varó la moto");
      assert.equal((await getCourier(w.courier.id)).status, "paused");
    });

    it("sin resumen del modelo, el motivo manda a revisar su chat", async () => {
      const w = await world();
      classifier.next({ tipo: "novedad" });
      await write(w, "problema");
      assert.equal((await getConversation(w.courierConversation.id)).escalationReason, "Novedad de Pedro Gómez: revisar su chat");
    });

    it("una moto en pausa por una novedad no queda libre al cerrar su servicio con los botones", async () => {
      const w = await world();
      const { trip } = await ticketed(w);
      classifier.next({ tipo: "novedad", resumen: "Se accidentó" });
      await write(w, "me accidenté");
      await pickedUp(trip.id);
      await tap(w, `done:customer:finish:${trip.id}`);
      assert.equal((await getTrip(trip.id)).status, "delivered", "el botón sigue cerrando el servicio");
      assert.equal((await getCourier(w.courier.id)).status, "paused", "pero la pausa la quita la central");
    });

    it("«ficha» devuelve la ficha de cada pedido en la fase en que va, sin pausar nada", async () => {
      const w = await world();
      const first = await ticketed(w);
      const second = await ticketed(w);
      await pickedUp(first.trip.id);
      classifier.next({ tipo: "ficha" });
      await write(w, "mándame la ficha");
      const sent = toCourier(w);
      assert.equal(sent.length, 2);
      const mine = (id: number) => sent.find((m) => m.buttons.some((b) => b.id.endsWith(`:${id}`)))!;
      assert.match(plain(mine(first.trip.id).text), /Perfecto, ahora lleva el pedido/);
      assert.match(plain(mine(second.trip.id).text), /tienes un nuevo pedido|Tienes un nuevo pedido/);
      assert.equal((await getCourier(w.courier.id)).status, "busy");
      assert.equal((await getConversation(w.courierConversation.id)).botPaused, false);
    });

    it("«ficha» sin pedidos no manda nada", async () => {
      const w = await world();
      classifier.next({ tipo: "ficha" });
      await write(w, "la ficha");
      assert.equal(outbox.length, 0);
    });

    it("un mensaje que no es novedad («otro») no responde ni pausa", async () => {
      const w = await world();
      await ticketed(w);
      classifier.next({ tipo: "otro" });
      await write(w, "gracias");
      assert.equal(outbox.length, 0);
      assert.equal((await getConversation(w.courierConversation.id)).botPaused, false);
      assert.equal((await getCourier(w.courier.id)).status, "busy");
    });
  });

  describe("seguridad ante una caída de OpenAI", () => {
    // Un mensaje que ninguna regla reconoce llega al clasificador; si este no
    // puede leerlo, no se deja pasar: se trata como novedad y lo ve una persona.
    const failures = [
      ["la red falla", "network"],
      ["OpenAI responde 500", "http500"],
      ["la respuesta no es JSON", "badjson"],
      ["la respuesta viene vacía", "empty"],
    ] as const;

    for (const [name, failure] of failures) {
      it(`cuando ${name}: se trata como novedad y escala a la central`, async () => {
        const w = await world();
        const { trip } = await ticketed(w);
        classifier.next(failure);
        await write(w, "se me acabó la gasolina");
        assert.equal(classified.length, 1, "sí se intentó clasificar");
        assert.equal((await getCourier(w.courier.id)).status, "paused");
        const conversation = await getConversation(w.courierConversation.id);
        assert.equal(conversation.botPaused, true);
        assert.equal(conversation.escalationReason, `Novedad de Pedro Gómez (${trip.code}): No se pudo leer su mensaje`);
        assert.equal(plain(toCourier(w)[0].text), "Recibido 🙏 La central ya te contacta.");
      });
    }

    it("una clasificación que el modelo inventó (tipo desconocido) también es novedad", async () => {
      const w = await world();
      classifier.next({ tipo: "quizás" });
      await write(w, "hola?");
      assert.equal((await getCourier(w.courier.id)).status, "paused");
      assert.equal((await getConversation(w.courierConversation.id)).botPaused, true);
    });

    it("sin llave de OpenAI configurada, igual: novedad", async () => {
      const w = await world();
      const key = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        await write(w, "no puedo seguir");
      } finally {
        process.env.OPENAI_API_KEY = key;
      }
      assert.equal(classified.length, 0, "ni siquiera salió la petición");
      assert.equal((await getCourier(w.courier.id)).status, "paused");
      assert.equal((await getConversation(w.courierConversation.id)).botPaused, true);
    });

    it("lo que no necesita a OpenAI (botones y frases claras) sigue funcionando aunque esté caído", async () => {
      const w = await world();
      const { trip } = await ticketed(w);
      classifier.next("network");
      await write(w, "ya recogí");
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
      assert.equal(classified.length, 0);
      assert.equal((await getCourier(w.courier.id)).status, "busy", "no pausó nada");
    });
  });

  describe("con el chat pausado (botPaused = true)", () => {
    async function paused(w: World) {
      await db.update(schema.conversations).set({ botPaused: true, escalationReason: "Novedad de Pedro Gómez: x" }).where(eq(schema.conversations.id, w.courierConversation.id));
    }

    it("los botones siguen cerrando el servicio: «Recogí», entrega, no contesta y devuelto", async () => {
      const w = await world();
      const { trip } = await ticketed(w);
      await paused(w);
      await tap(w, `going:${trip.id}`);
      assert.ok((await getAssignment(trip.id)).seenAt);
      await tap(w, `picked:${trip.id}`);
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
      await tap(w, `noanswer:${trip.id}`);
      assert.ok((await getAssignment(trip.id)).customerWaitAt);
      await tap(w, `done:gate:finish:${trip.id}`);
      assert.equal((await getTrip(trip.id)).status, "delivered");
      assert.equal((await getAssignment(trip.id)).deliveryPlace, "gate");
    });

    it("el botón de «Devolví el pedido» también", async () => {
      const w = await world();
      const { trip } = await ticketed(w);
      await pickedUp(trip.id);
      await setAssignment(trip.id, { customerWaitAt: minutesAgo(12), undeliveredAt: minutesAgo(1) });
      await paused(w);
      await tap(w, `returned:${trip.id}`);
      assert.equal((await getTrip(trip.id)).status, "cancelled");
    });

    it("el botón de cerrar un pendiente también", async () => {
      const w = await world();
      const { trip } = await ticketed(w);
      await pickedUp(trip.id);
      const { debt } = await declareReturnDebt({ courierId: w.courier.id, reason: "plata", restaurantName: "Pizza Nona", restaurantId: w.restaurant.id, tripId: trip.id, declaredBy: "courier" });
      await paused(w);
      await tap(w, `debtok:${debt.id}`);
      assert.ok((await getReturnDebt(debt.id))?.resolvedAt);
    });

    it("lo escrito queda en silencio, para que lo atienda el asesor: ni reglas, ni OpenAI, ni respuesta", async () => {
      const w = await world();
      const { trip } = await ticketed(w);
      await paused(w);
      for (const said of ["ya recogí", "ok", "entregué", "desactivado", "llevo datáfono", "se me dañó la moto"]) await write(w, said);
      assert.equal(outbox.length, 0);
      assert.equal(classified.length, 0);
      const a = await getAssignment(trip.id);
      assert.deepEqual([a.seenAt, a.pickedUpAt, a.deliveredAt], [null, null, null]);
      assert.equal((await getCourier(w.courier.id)).status, "busy");
      assert.equal((await openReturnDebts()).length, 0);
      assert.equal((await getConversation(w.courierConversation.id)).escalationReason, "Novedad de Pedro Gómez: x", "el motivo no se pisa");
    });

    it("un mensaje que no es texto tampoco se atiende", async () => {
      const w = await world();
      await paused(w);
      await act(w, { ...textFrom(w.courier.phone, ""), kind: "location", lat: 3.4, lng: -76.5, label: null } as IncomingMessage);
      assert.equal(outbox.length, 0);
    });
  });

  describe("conectarse escribiendo", () => {
    it("desconectado y sin pedidos (ya activado): escribir lo conecta y le da la bienvenida", async () => {
      const w = await world({ courier: { status: "offline" } });
      await completeCourierOnboarding(w.courier.id);
      classifier.next({ tipo: "otro" });
      await write(w, "hola");
      assert.equal((await getCourier(w.courier.id)).status, "available");
      assert.equal(plain(toCourier(w)[0].text), "👋 Pedro, quedaste conectado. Te escribo apenas tengas un servicio 🛵 Para desconectarte escribe desactivado.");
    });

    it("en pausa: escribir no lo conecta (la pone y la quita la central)", async () => {
      const w = await world({ courier: { status: "paused" } });
      classifier.next({ tipo: "otro" });
      await write(w, "hola");
      assert.equal((await getCourier(w.courier.id)).status, "paused");
      assert.equal(outbox.length, 0);
    });

    it("disponible: «hola» no responde", async () => {
      const w = await world();
      classifier.next({ tipo: "otro" });
      await write(w, "hola");
      assert.equal(outbox.length, 0);
      assert.equal((await getCourier(w.courier.id)).status, "available");
    });

    it("simulador de staging: un número real que ya eligió ser de prueba se conecta y se entera de que es de prueba", async () => {
      process.env.SIMULATOR_ENABLED = "1";
      const w = await world({ courier: { status: "offline" } });
      await completeCourierOnboarding(w.courier.id);
      classifier.next({ tipo: "otro" });
      await write(w, "hola");
      assert.equal((await getCourier(w.courier.id)).status, "available");
      assert.equal(
        plain(toCourier(w)[0].text),
        "🧪 Pedro, quedaste conectado como número de prueba del simulador. Te llega el próximo pedido que reciba una moto simulada 🛵 Para desconectarte escribe desactivado.",
      );
    });

    it("simulador: libre y sin pedidos, un texto suyo recibe el recordatorio de que es número de prueba", async () => {
      process.env.SIMULATOR_ENABLED = "1";
      const w = await world();
      classifier.next({ tipo: "otro" });
      await write(w, "hola");
      assert.equal(plain(toCourier(w)[0].text), "🧪 Estás libre como número de prueba: te llega el próximo pedido que reciba una moto simulada.");
    });

    it("simulador: una moto simulada, y quien lleva pedidos, no reciben ese aviso", async () => {
      const busy = await world();
      await ticketed(busy); // se asigna con el simulador apagado: con él, solo reciben las motos simuladas
      process.env.SIMULATOR_ENABLED = "1";
      const sim = await world({ courier: { status: "offline", simulated: true } });
      classifier.next({ tipo: "otro" });
      await write(sim, "hola");
      assert.match(plain(toCourier(sim)[0].text), /^👋 Pedro, quedaste conectado\./);
      classifier.next({ tipo: "otro" });
      await write(busy, "hola");
      assert.equal(outbox.filter((m) => m.text.includes("🧪")).length, 0);
    });

    it("sin el simulador encendido, nada de eso aparece", async () => {
      const w = await world();
      classifier.next({ tipo: "otro" });
      await write(w, "hola");
      assert.equal(outbox.length, 0);
    });

    it("un motorizado inactivo no lo reconoce el bot", async () => {
      const w = await world();
      await db.update(schema.couriers).set({ active: false }).where(eq(schema.couriers.id, w.courier.id));
      assert.equal(await courier.findCourier(w.courier.phone), null);
    });

    it("lo reconoce por los últimos 10 dígitos (3001234567 y 573001234567 son el mismo)", async () => {
      const w = await world({ courier: { phone: "3001234567" } });
      assert.equal((await courier.findCourier("573001234567"))?.id, w.courier.id);
      assert.equal((await courier.findCourier("+57 300 123 4567"))?.id, w.courier.id);
      assert.equal(await courier.findCourier("573009999999"), null);
    });
  });
});
