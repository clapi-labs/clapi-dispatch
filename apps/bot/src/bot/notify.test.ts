import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, declareReturnDebt, deliverTrip, getReturnDebt, openDebtClaims, openReturnDebts, recordDebtClaim, schema } from "@dispatch/shared/db";
import { closeTestDatabase, createCourier, createRestaurant, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  getAssignment,
  installMocks,
  minutesAgo,
  outbox,
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
 * Los mensajes que el bot le manda al motorizado y al restaurante, y lo que
 * corre el tick (`notify.ts`): el formato de los mensajes 1 y 2, los
 * recordatorios, el cierre de la espera al cliente y los reclamos de datáfono o
 * plata. WhatsApp y OpenAI son simulados; el viaje, las asignaciones, los
 * pendientes y la demanda son los de verdad, en el Postgres de pruebas. La
 * primera parte (el formato) no necesita base.
 */

type Notify = typeof import("./notify");
type Trip = typeof schema.trips.$inferSelect;
let notify: Notify;

before(async () => {
  await installMocks();
  notify = await import("./notify");
});

after(restoreMocks);

// ---------------------------------------------------------------------------
// El formato de los mensajes (puro: sin base)
// ---------------------------------------------------------------------------

const trip = (over: Partial<Trip> = {}) =>
  ({
    id: 1,
    code: "A-07",
    originRestaurantName: "Pizza Nona",
    pickupAddress: "Calle 5 # 38-10",
    pickupLocation: { lat: 3.45, lng: -76.53 },
    deliveryAddress: "Calle 10 # 5-20 · Torre 2 apto 301",
    deliveryLocation: { lat: 3.46, lng: -76.52 },
    deliveryZone: "Ciudad Jardín",
    customerName: "Marta Ríos",
    customerPhone: "3001234567",
    valueToCollect: null,
    paymentMethod: null,
    notes: null,
    readyAt: null,
    ...over,
  }) as Trip;

describe("mensaje 1: solo para ir a recoger", () => {
  it("lleva el pedido, dónde recoger, la ruta en Waze con las coordenadas y cómo seguir", () => {
    const text = notify.pickupTicket(trip(), "Pedro Gómez");
    assert.match(text, /^🛵 \*Pedro, tienes un nuevo pedido A-07\*/);
    assert.match(text, /\*Recoge en:\* Pizza Nona · Calle 5 # 38-10/);
    assert.match(text, /\*Va para:\* Ciudad Jardín/);
    assert.match(text, /\*Ruta en Waze:\* https:\/\/waze\.com\/ul\?ll=3\.45,-76\.53&navigate=yes/);
    assert.match(text, /Toca «Recogí» cuando tengas el pedido: ahí te mando a dónde va\./);
    assert.match(text, /toca ese botón en vez de «Recogí»\./);
  });

  it("no adelanta lo que es del mensaje 2: ni la dirección de entrega ni el cliente", () => {
    const text = notify.pickupTicket(trip(), "Pedro");
    assert.ok(!text.includes("Calle 10 # 5-20"));
    assert.ok(!text.includes("Marta"));
    assert.ok(!text.includes("300 123 4567"));
    assert.ok(!text.includes("3001234567"));
    assert.ok(!text.includes("3.46,-76.52"), "ni el punto de entrega");
  });

  it("sin nombre, el saludo es genérico", () => {
    assert.match(notify.pickupTicket(trip(), null), /^🛵 \*Tienes un nuevo pedido A-07\*/);
    assert.match(notify.pickupTicket(trip(), "  "), /^🛵 \*Tienes un nuevo pedido A-07\*/);
  });

  it("solo el primer nombre", () => {
    assert.match(notify.pickupTicket(trip(), "Juan Pablo Rodríguez"), /\*Juan, tienes un nuevo pedido/);
  });

  it("sin dirección de recogida, nombra solo al restaurante y busca en Waze por nombre", () => {
    const text = notify.pickupTicket(trip({ pickupAddress: null, pickupLocation: null }), "Pedro");
    assert.match(text, /\*Recoge en:\* Pizza Nona\n/);
    assert.match(text, new RegExp(`https://waze\\.com/ul\\?q=${encodeURIComponent("Pizza Nona, Cali").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}&navigate=yes`));
  });

  it("sin coordenadas busca por la dirección, en Cali", () => {
    const text = notify.pickupTicket(trip({ pickupLocation: null }), "Pedro");
    assert.ok(text.includes(`https://waze.com/ul?q=${encodeURIComponent("Calle 5 # 38-10, Cali")}&navigate=yes`));
  });

  it("«Está listo a las» solo si la comida todavía no está lista", () => {
    assert.match(notify.pickupTicket(trip({ readyAt: new Date(Date.now() + 15 * 60_000) }), "Pedro"), /\*Está listo a las:\* \d{1,2}:\d{2}/);
    assert.ok(!notify.pickupTicket(trip({ readyAt: new Date(Date.now() - 5 * 60_000) }), "Pedro").includes("Está listo a las"));
    assert.ok(!notify.pickupTicket(trip({ readyAt: null }), "Pedro").includes("Está listo a las"));
  });

  it("el cobro va aquí, porque tiene que saber antes de salir si necesita base o datáfono", () => {
    assert.ok(plain(notify.pickupTicket(trip({ paymentMethod: "efectivo", valueToCollect: 50_000 }), "Pedro")).includes("Cobra en efectivo $ 50.000."));
    assert.ok(notify.pickupTicket(trip({ paymentMethod: "efectivo" }), "Pedro").includes("Cobra en efectivo."));
    assert.ok(notify.pickupTicket(trip({ paymentMethod: "transferencia" }), "Pedro").includes("Ya está pagado, no cobres."));
    const datafono = plain(notify.pickupTicket(trip({ paymentMethod: "datafono", valueToCollect: 30_000 }), "Pedro"));
    assert.ok(datafono.includes("💳 El cliente paga con tarjeta: $ 30.000."));
    assert.ok(datafono.includes("*Pide el datáfono en el restaurante.*"));
    assert.ok(plain(notify.pickupTicket(trip({ valueToCollect: 20_000 }), "Pedro")).includes("Valor del pedido: $ 20.000."));
    assert.ok(!notify.pickupTicket(trip(), "Pedro").includes("Cobra"));
  });

  it("las indicaciones y el aviso de que aprovecha un regreso van cuando hay", () => {
    const text = notify.pickupTicket(trip({ notes: "Billete de 100 mil" }), "Pedro", { sameTrip: "♻️ *Aprovecha y devuelve el datáfono en Pizza Nona.*" });
    assert.match(text, /\*Indicaciones:\* Billete de 100 mil/);
    assert.match(text, /♻️ \*Aprovecha y devuelve el datáfono en Pizza Nona\.\*/);
    assert.ok(!notify.pickupTicket(trip(), "Pedro").includes("Indicaciones"));
  });

  it("cada idea va en su párrafo, separadas por una línea en blanco", () => {
    const parts = notify.pickupTicket(trip({ notes: "x" }), "Pedro").split("\n\n");
    assert.ok(parts.length >= 6);
    assert.ok(parts.every((p) => p.trim().length > 0));
  });
});

describe("mensaje 2: lo necesario para entregar", () => {
  it("lleva la dirección completa, el cliente con su teléfono formateado y la ruta en Waze al punto de entrega", () => {
    const text = notify.deliveryTicket(trip());
    assert.match(text, /^📦 \*Perfecto, ahora lleva el pedido A-07\*/);
    assert.match(text, /\*Entrega en:\* Calle 10 # 5-20 · Torre 2 apto 301/);
    assert.match(text, /\*Cliente:\* Marta Ríos · 300 123 4567/);
    assert.match(text, /\*Ruta en Waze:\* https:\/\/waze\.com\/ul\?ll=3\.46,-76\.52&navigate=yes/);
    assert.match(text, /Cuando lo entregues, toca «Entregado» o «En portería»\./);
  });

  it("ya no habla de recoger", () => {
    const text = notify.deliveryTicket(trip());
    assert.ok(!text.includes("Recoge en"));
    assert.ok(!text.includes("Calle 5 # 38-10"));
    assert.ok(!text.includes("3.45,-76.53"));
  });

  it("sin coordenadas busca solo por la calle: la torre y el apto confunden la búsqueda", () => {
    const text = notify.deliveryTicket(trip({ deliveryLocation: null }));
    const waze = text.split(/\r?\n/).find((line) => line.includes("waze.com")) ?? "";
    assert.ok(waze.includes(`https://waze.com/ul?q=${encodeURIComponent("Calle 10 # 5-20, Cali")}&navigate=yes`));
    assert.ok(!waze.includes("Torre") && !waze.includes("apto"), "el enlace lleva solo la calle");
  });

  it("el cliente puede tener solo nombre, solo teléfono o ninguno", () => {
    assert.match(notify.deliveryTicket(trip({ customerPhone: null })), /\*Cliente:\* Marta Ríos\n/);
    assert.match(notify.deliveryTicket(trip({ customerName: null })), /\*Cliente:\* 300 123 4567/);
    assert.ok(!notify.deliveryTicket(trip({ customerName: null, customerPhone: null })).includes("Cliente:"));
  });

  it("un teléfono que no es de 10 dígitos se deja como llegó", () => {
    assert.match(notify.deliveryTicket(trip({ customerName: null, customerPhone: "6025551" })), /\*Cliente:\* 6025551/);
  });

  it("repite el cobro y las indicaciones", () => {
    const text = plain(notify.deliveryTicket(trip({ paymentMethod: "efectivo", valueToCollect: 45_000, notes: "Torre B, portería" })));
    assert.ok(text.includes("Cobra en efectivo $ 45.000."));
    assert.ok(text.includes("*Indicaciones:* Torre B, portería"));
  });

  it("si la recogida la marcó el GPS, le dice cómo declarar el datáfono o la plata", () => {
    assert.ok(notify.deliveryTicket(trip(), { byGps: true }).includes("Escríbeme «llevo datáfono» o «quedé debiendo»."));
    assert.ok(!notify.deliveryTicket(trip()).includes("llevo datáfono"));
  });
});

describe("otros mensajes", () => {
  it("el cliente no contestó: devolver el pedido al restaurante", () => {
    assert.equal(notify.undeliveredText(trip()), "⏰ El cliente del pedido A-07 no contestó. Devuélvelo a Pizza Nona y toca «Devolví el pedido».");
  });

  it("recordatorio de «Voy en camino» y de «Recogí», con y sin nombre", () => {
    assert.equal(notify.goingReminderText(trip(), "Pedro Gómez"), "⏰ Pedro, ¿ya vas por el pedido A-07? Recoge en Pizza Nona.");
    assert.equal(notify.goingReminderText(trip(), null), "⏰ ¿Ya vas por el pedido A-07? Recoge en Pizza Nona.");
    assert.equal(notify.pickupReminderText(trip(), "Pedro Gómez"), "⏰ Pedro, el pedido A-07 ya está listo en Pizza Nona. ¿Vas en camino?");
    assert.equal(notify.pickupReminderText(trip(), null), "⏰ El pedido A-07 ya está listo en Pizza Nona. ¿Vas en camino?");
  });
});

// ---------------------------------------------------------------------------
// Con la base
// ---------------------------------------------------------------------------

beforeEach(async () => {
  resetMocks();
  delete process.env.BOT_HOST;
  delete process.env.WHATSAPP_SIMULADO;
  if (integrationSkip) return;
  await resetDatabase();
});

const toCourier = (w: World) => sentTo(w.courier.phone);
const toRestaurant = (w: World) => sentTo(w.restaurantConversation.phone);

async function setBotConfig(value: Record<string, unknown>) {
  await db.insert(schema.settings).values({ key: "bot_config", value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}
async function setDemand(level: "alta" | "baja") {
  await db.insert(schema.demandState).values({ id: 1, level }).onConflictDoUpdate({ target: schema.demandState.id, set: { level } });
}

/** Un pedido asignado con su mensaje 1 ya enviado. */
async function ticketed(w: World, over: Parameters<typeof assignedTrip>[1] = {}, who?: Parameters<typeof assignedTrip>[2]) {
  const t = await assignedTrip(w, over, who);
  await notify.notifyAssigned(t.trip.id);
  outbox.length = 0;
  return t;
}

/** El motorizado entregó: el pedido queda entregado y su pendiente, anotado. */
async function debtWithDeliveredTrip(w: World, reason: "datafono" | "plata", over: { restaurantName?: string; restaurantId?: number | null } = {}) {
  const { trip: t } = await assignedTrip(w);
  const { debt } = await declareReturnDebt({
    courierId: w.courier.id,
    reason,
    restaurantName: over.restaurantName ?? "Pizza Nona",
    restaurantId: over.restaurantId === undefined ? w.restaurant.id : over.restaurantId,
    tripId: t.id,
    declaredBy: "courier",
  });
  await setAssignment(t.id, { seenAt: minutesAgo(10), pickedUpAt: minutesAgo(5) });
  await deliverTrip(t.id, { place: "customer" });
  return { trip: t, debt };
}

describe("notify.ts: avisos y tick (Postgres)", { skip: integrationSkip }, () => {
  after(closeTestDatabase);

  describe("moto asignada (notifyAssigned)", () => {
    it("el motorizado recibe el mensaje 1 con sus tres botones de recogida", async () => {
      const w = await world();
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      const [ticket] = toCourier(w);
      assert.match(plain(ticket.text), /^🛵 \*Pedro, tienes un nuevo pedido A-\d+\*/);
      assert.match(plain(ticket.text), /\*Recoge en:\* Pizza Nona · Calle 5 # 38-10/);
      assert.deepEqual(ticket.buttons.map((b) => b.id), [`picked:${t.id}`, `pickdebt:datafono:${t.id}`, `pickdebt:plata:${t.id}`]);
      assert.ok(!ticket.text.includes("Marta"), "todavía sin los datos del cliente");
    });

    it("con el aviso extra encendido, al restaurante se le dice quién va, citando su pedido, y sin el número del domiciliario", async () => {
      const w = await world();
      await setBotConfig({ notifyRestaurantOnAssign: true });
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      const [msg] = toRestaurant(w);
      assert.equal(msg.text, `🛵 Pedido ${t.code}: va Pedro Gómez.`);
      assert.equal(msg.replyTo, t.sourceWaMessageId);
      assert.ok(!msg.text.includes(w.courier.phone));
    });

    it("asignada al confirmar: el aviso es la confirmación, con el precio y quién va", async () => {
      const w = await world();
      const { trip: t } = await assignedTrip(w, { deliveryFee: 5_000 });
      await notify.notifyAssigned(t.id, { atConfirmation: true });
      const text = plain(toRestaurant(w)[0].text);
      assert.match(text, new RegExp(`✅ Servicio motorizado confirmado para el pedido ${t.code} · \\$ 5\\.000\\.`));
      assert.match(text, /Va Pedro Gómez\./);
    });

    it("por defecto el aviso extra de asignación está apagado: el restaurante no recibe nada; al confirmar, sí", async () => {
      const w = await world();
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      assert.equal(toRestaurant(w).length, 0);
      assert.equal(toCourier(w).length, 1);
      const second = await assignedTrip(w);
      outbox.length = 0;
      await notify.notifyAssigned(second.trip.id, { atConfirmation: true });
      assert.equal(toRestaurant(w).length, 1);
    });

    it("un pedido sin moto o que no existe no manda nada", async () => {
      const w = await world();
      const loose = await (await import("@dispatch/shared/db/test-db")).createTrip({ conversationId: w.restaurantConversation.id });
      await notify.notifyAssigned(loose.id);
      await notify.notifyAssigned(99_999);
      assert.equal(outbox.length, 0);
    });

    it("un pedido sin conversación de restaurante (del simulador) solo le avisa a la moto", async () => {
      const w = await world();
      const { trip: t } = await assignedTrip(w, { conversationId: null });
      await notify.notifyAssigned(t.id, { atConfirmation: true });
      assert.equal(toCourier(w).length, 1);
      assert.equal(outbox.length, 1);
    });

    it("si recoge donde ya tiene un datáfono pendiente, se le dice que aproveche y la plata entra en su ruta", async () => {
      const w = await world();
      await debtWithDeliveredTrip(w, "datafono");
      const { debt: owed } = await debtWithDeliveredTrip(w, "plata");
      outbox.length = 0;
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      assert.match(plain(toCourier(w)[0].text), /♻️ \*Aprovecha y devuelve el datáfono y paga en Pizza Nona\.\*/);
      assert.ok((await getReturnDebt(owed.id))?.resolvedAt === null);
      const [row] = await db.select().from(schema.returnDebts).where(eq(schema.returnDebts.id, owed.id));
      assert.ok(row.routedAt, "la plata de ese restaurante entra en su ruta");
    });
  });

  describe("la ruta numerada de paradas", () => {
    it("con un solo pedido no se antepone ninguna ruta", async () => {
      const w = await world();
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      assert.ok(toCourier(w)[0].text.startsWith("🛵 *Pedro, tienes un nuevo pedido"));
      assert.ok(!toCourier(w)[0].text.includes("Tu ruta"));
    });

    it("con dos pedidos, cada mensaje empieza con la lista numerada y la primera parada marcada", async () => {
      const w = await world();
      const first = await ticketed(w);
      await new Promise((r) => setTimeout(r, 15));
      const second = await assignedTrip(w);
      await notify.notifyAssigned(second.trip.id);
      const [msg] = toCourier(w);
      const [route, ...rest] = msg.text.split("\n\n");
      assert.equal(
        route,
        [
          "🧭 *Tu ruta:*",
          `1. ➡️ Recoge ${first.trip.code} en Pizza Nona`,
          `2. Entrega ${first.trip.code}`,
          `3. Recoge ${second.trip.code} en Pizza Nona`,
          `4. Entrega ${second.trip.code}`,
        ].join("\n"),
      );
      assert.match(rest[0], /^🛵 \*Pedro, tienes un nuevo pedido/);
    });

    it("lo ya recogido solo deja la entrega en la lista", async () => {
      const w = await world();
      const first = await ticketed(w);
      await new Promise((r) => setTimeout(r, 15));
      await ticketed(w);
      await setAssignment(first.trip.id, { seenAt: minutesAgo(5), pickedUpAt: minutesAgo(1) });
      await notify.notifyPicked(first.trip.id);
      const [route] = toCourier(w)[0].text.split("\n\n");
      assert.match(route, /^🧭 \*Tu ruta:\*\n1\. ➡️ Entrega A-\d+\n2\. Recoge A-\d+ en Pizza Nona\n3\. Entrega A-\d+$/);
    });

    it("un regreso (datáfono) entra en la lista con su restaurante", async () => {
      const w = await world();
      const brasa = await createRestaurant({ name: "La Brasa", knownPickupAddress: "Cra 1 # 2-3", knownPickupLocation: { lat: 3.44, lng: -76.52 } });
      await declareReturnDebt({ courierId: w.courier.id, reason: "datafono", restaurantName: "La Brasa", restaurantId: brasa.id, declaredBy: "central" });
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      const [route] = toCourier(w)[0].text.split("\n\n");
      assert.match(route, /Devuelve el datáfono en La Brasa/);
      assert.match(route, /Recoge A-\d+ en Pizza Nona/);
      assert.match(route, /Entrega A-\d+/);
      assert.match(route, /^🧭 \*Tu ruta:\*\n1\. ➡️ /);
    });

    it("también va en lo que se le contesta después (por ejemplo, el mensaje 2)", async () => {
      const w = await world();
      const first = await ticketed(w);
      await ticketed(w);
      await setAssignment(first.trip.id, { seenAt: minutesAgo(5), pickedUpAt: minutesAgo(1) });
      await notify.notifyPicked(first.trip.id);
      assert.ok(toCourier(w)[0].text.startsWith("🧭 *Tu ruta:*"));
      assert.match(toCourier(w)[0].text, /Perfecto, ahora lleva el pedido/);
    });
  });

  describe("«Recogí», «Voy en camino», cambios y quitarle el pedido", () => {
    it("el mensaje 2 cita el mensaje 1 de ese pedido y trae los botones de entrega", async () => {
      const w = await world();
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      const ticket = toCourier(w)[0];
      outbox.length = 0;
      await notify.notifyPicked(t.id);
      const [msg] = toCourier(w);
      assert.equal(msg.replyTo, ticket.wamid);
      assert.deepEqual(msg.buttons.map((b) => b.id), [`done:customer:finish:${t.id}`, `done:gate:finish:${t.id}`, `noanswer:${t.id}`]);
    });

    it("«Voy en camino» no responde, salvo que sea el botón viejo o la agencia lo pida", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await notify.notifyGoing(t.id);
      assert.equal(outbox.length, 0);
      await notify.notifyGoing(t.id, { old: true });
      assert.equal(toCourier(w).length, 1);
    });

    it("un cambio del restaurante le llega al motorizado citando su ficha", async () => {
      const w = await world();
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      const ticket = toCourier(w)[0];
      outbox.length = 0;
      await notify.notifyTripUpdated(t.id, "la comida ya está lista");
      assert.equal(toCourier(w)[0].text, `📢 ${t.code}: la comida ya está lista`);
      assert.equal(toCourier(w)[0].replyTo, ticket.wamid);
    });

    it("un cambio en un pedido sin moto no avisa a nadie", async () => {
      const w = await world();
      const loose = await (await import("@dispatch/shared/db/test-db")).createTrip({ conversationId: w.restaurantConversation.id });
      await notify.notifyTripUpdated(loose.id, "x");
      assert.equal(outbox.length, 0);
    });

    it("se le avisa que el pedido ya no está a su nombre", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await notify.notifyUnassigned(t.id, w.courier.id);
      assert.equal(toCourier(w)[0].text, `📢 El pedido ${t.code} ya no está a tu nombre, no vayas a recogerlo 🙏`);
      outbox.length = 0;
      await notify.notifyUnassigned(99_999, w.courier.id);
      await notify.notifyUnassigned(t.id, 99_999);
      assert.equal(outbox.length, 0);
    });

    it("la ficha que se reenvía va en la fase en que está el pedido", async () => {
      const w = await world();
      const { trip: t, assignment } = await ticketed(w);
      const send = (a: Parameters<typeof notify.sendCourierTicket>[3]) => notify.sendCourierTicket(w.courier.phone, t, "Pedro", { ...a, courierId: w.courier.id });
      await send(assignment);
      assert.match(plain(toCourier(w)[0].text), /nuevo pedido/);
      outbox.length = 0;
      await send({ ...assignment, seenAt: minutesAgo(5), pickedUpAt: minutesAgo(1) });
      assert.match(plain(toCourier(w)[0].text), /Perfecto, ahora lleva el pedido/);
      assert.equal(toCourier(w)[0].buttons.length, 3);
      outbox.length = 0;
      await send({ ...assignment, seenAt: minutesAgo(5), pickedUpAt: minutesAgo(3), customerWaitAt: minutesAgo(1) });
      assert.deepEqual(toCourier(w)[0].buttons.map((b) => b.id), [`done:customer:finish:${t.id}`, `done:gate:finish:${t.id}`], "esperando al cliente: sin «no contesta»");
      outbox.length = 0;
      await send({ ...assignment, seenAt: minutesAgo(5), pickedUpAt: minutesAgo(3), customerWaitAt: minutesAgo(2), undeliveredAt: minutesAgo(1) });
      assert.match(plain(toCourier(w)[0].text), /no contestó\. Devuélvelo a Pizza Nona/);
      assert.deepEqual(toCourier(w)[0].buttons.map((b) => b.id), [`returned:${t.id}`]);
    });
  });

  describe("remindCouriers(): recordatorios (una vez por asignación)", () => {
    it("a quien no ha confirmado después de seenReminderMinutes: «¿ya vas por el pedido?», con «Voy en camino» y «Recogí»", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(4) });
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
      const [msg] = toCourier(w);
      assert.equal(msg.text, `⏰ Pedro, ¿ya vas por el pedido ${t.code}? Recoge en Pizza Nona.`);
      assert.deepEqual(msg.buttons.map((b) => b.id), [`going:${t.id}`, `picked:${t.id}`]);
      assert.ok((await getAssignment(t.id)).seenReminderAt);
    });

    it("cita el mensaje 1 del pedido", async () => {
      const w = await world();
      const { trip: t } = await assignedTrip(w);
      await notify.notifyAssigned(t.id);
      const ticket = toCourier(w)[0];
      outbox.length = 0;
      await setAssignment(t.id, { assignedAt: minutesAgo(4) });
      await notify.remindCouriers();
      assert.equal(toCourier(w)[0].replyTo, ticket.wamid);
    });

    it("antes de tiempo no recuerda nada", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(1) });
      assert.deepEqual(await notify.remindCouriers(), []);
      assert.equal(outbox.length, 0);
      assert.equal((await getAssignment(t.id)).seenReminderAt, null);
    });

    it("respeta lo que configure la agencia", async () => {
      const w = await world();
      await setBotConfig({ seenReminderMinutes: 1 });
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(2) });
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
    });

    it("solo lo recuerda una vez: el siguiente tick no repite el mismo aviso", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(4) });
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
      assert.deepEqual(await notify.remindCouriers(), []);
      assert.equal(toCourier(w).length, 1);
    });

    it("dos ticks a la vez no lo mandan dos veces (se reclama con un UPDATE condicional)", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(4) });
      const [a, b] = await Promise.all([notify.remindCouriers(), notify.remindCouriers()]);
      assert.equal(a.length + b.length, 1);
      assert.equal(toCourier(w).length, 1);
    });

    it("si ya tocó «Voy en camino» no le recuerda que vaya", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(4), seenAt: minutesAgo(1) });
      assert.deepEqual(await notify.remindCouriers(), []);
    });

    it("con la comida para dentro de un rato no lo molesta todavía (espera hasta readyLeadMinutes antes)", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w, { readyAt: new Date(Date.now() + 30 * 60_000) });
      await setAssignment(t.id, { assignedAt: minutesAgo(5) });
      assert.deepEqual(await notify.remindCouriers(), []);
      // Ya faltan menos de readyLeadMinutes (10): ahora sí.
      await db.update(schema.trips).set({ readyAt: new Date(Date.now() + 5 * 60_000) }).where(eq(schema.trips.id, t.id));
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
    });

    it("«ya está listo»: a quien confirmó pero no ha recogido, pasados pickupLateMinutes, con los tres botones de recogida", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(11), seenAt: minutesAgo(8) });
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
      const [msg] = toCourier(w);
      assert.equal(msg.text, `⏰ Pedro, el pedido ${t.code} ya está listo en Pizza Nona. ¿Vas en camino?`);
      assert.deepEqual(msg.buttons.map((b) => b.id), [`picked:${t.id}`, `pickdebt:datafono:${t.id}`, `pickdebt:plata:${t.id}`]);
      assert.ok((await getAssignment(t.id)).pickupReminderAt);
      assert.deepEqual(await notify.remindCouriers(), [], "una sola vez");
    });

    it("cuenta desde readyAt cuando es posterior a la asignación, y desde la asignación si se asignó tarde", async () => {
      const w = await world();
      // Lista hace 5 min, asignada hace 20: todavía falta (listo + 10).
      const early = await ticketed(w, { readyAt: minutesAgo(5) });
      await setAssignment(early.trip.id, { assignedAt: minutesAgo(20), seenAt: minutesAgo(15) });
      assert.deepEqual(await notify.remindCouriers(), []);
      // Lista hace 12: ya pasó (listo + 10).
      await db.update(schema.trips).set({ readyAt: minutesAgo(12) }).where(eq(schema.trips.id, early.trip.id));
      assert.deepEqual(await notify.remindCouriers(), [early.trip.id]);
    });

    it("asignada tarde (la comida ya estaba lista): cuenta desde la asignación, no antes", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w, { readyAt: minutesAgo(30) });
      await setAssignment(t.id, { assignedAt: minutesAgo(5), seenAt: minutesAgo(4) });
      assert.deepEqual(await notify.remindCouriers(), [], "solo van 5 min desde que se le asignó");
      await setAssignment(t.id, { assignedAt: minutesAgo(11) });
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
    });

    it("en el punto de recogida solo corre el «ya está listo», no el «¿ya vas?»", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(11), atPickupAt: minutesAgo(1) });
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
      assert.match(toCourier(w)[0].text, /ya está listo en Pizza Nona/);
    });

    it("si pasaron los dos plazos, primero «¿ya vas?», luego «ya está listo», y después nada", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { assignedAt: minutesAgo(15) });
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
      assert.match(toCourier(w)[0].text, /¿ya vas por el pedido/);
      assert.deepEqual(await notify.remindCouriers(), [t.id]);
      assert.match(toCourier(w)[1].text, /ya está listo en Pizza Nona/);
      assert.deepEqual(await notify.remindCouriers(), []);
      assert.equal(toCourier(w).length, 2);
    });

    it("lo ya recogido, entregado o cancelado no se recuerda", async () => {
      const w = await world();
      const picked = await ticketed(w);
      await setAssignment(picked.trip.id, { assignedAt: minutesAgo(30), seenAt: minutesAgo(20), pickedUpAt: minutesAgo(10) });
      const delivered = await ticketed(w);
      await setAssignment(delivered.trip.id, { assignedAt: minutesAgo(30) });
      await db.update(schema.trips).set({ status: "delivered" }).where(eq(schema.trips.id, delivered.trip.id));
      const cancelled = await ticketed(w);
      await setAssignment(cancelled.trip.id, { assignedAt: minutesAgo(30) });
      await db.update(schema.trips).set({ status: "cancelled" }).where(eq(schema.trips.id, cancelled.trip.id));
      assert.deepEqual(await notify.remindCouriers(), []);
      assert.equal(outbox.length, 0);
    });

    describe("con paradas previas (no ir todavía no es demora)", () => {
      it("al segundo pedido no se le recuerda mientras no le toque recogerlo", async () => {
        const w = await world();
        const first = await ticketed(w);
        await new Promise((r) => setTimeout(r, 15));
        const second = await ticketed(w);
        await setAssignment(first.trip.id, { assignedAt: minutesAgo(20) });
        await setAssignment(second.trip.id, { assignedAt: minutesAgo(19) });
        // El primero es la primera parada: a ese sí; al segundo no.
        assert.deepEqual(await notify.remindCouriers(), [first.trip.id]);
        assert.equal((await getAssignment(second.trip.id)).seenReminderAt, null);
        // Recogió el primero: su primera parada es entregarlo, así que el segundo sigue esperando.
        await setAssignment(first.trip.id, { seenAt: minutesAgo(10), pickedUpAt: minutesAgo(1) });
        assert.deepEqual(await notify.remindCouriers(), []);
        // Lo entregó: ahora la primera parada es recoger el segundo.
        await deliverTrip(first.trip.id, { place: "customer" });
        assert.deepEqual(await notify.remindCouriers(), [second.trip.id]);
      });

      it("con un regreso (datáfono) como primera parada no se le recuerda recoger", async () => {
        const w = await world();
        const brasa = await createRestaurant({ name: "La Brasa", knownPickupAddress: "Cra 1 # 2-3", knownPickupLocation: { lat: 3.44, lng: -76.52 } });
        await declareReturnDebt({ courierId: w.courier.id, reason: "datafono", restaurantName: "La Brasa", restaurantId: brasa.id, declaredBy: "central" });
        const { trip: t } = await ticketed(w);
        await setAssignment(t.id, { assignedAt: minutesAgo(20) });
        assert.deepEqual(await notify.remindCouriers(), []);
        assert.equal(outbox.length, 0);
      });

      it("cada motorizado se evalúa por su cuenta", async () => {
        const w = await world();
        const lone = await createCourier({ name: "Luis Pérez", status: "available" });
        await ticketed(w);
        const other = await assignedTrip(w, {}, { courier: lone });
        await setAssignment(other.trip.id, { assignedAt: minutesAgo(10) });
        const first = (await db.select().from(schema.assignments).where(eq(schema.assignments.courierId, w.courier.id)))[0];
        await setAssignment(first.tripId, { assignedAt: minutesAgo(10) });
        const reminded = await notify.remindCouriers();
        assert.deepEqual(reminded.sort(), [first.tripId, other.trip.id].sort());
      });
    });
  });

  describe("closeCustomerWaits(): vence la espera al cliente", () => {
    async function waiting(w: World, minutes: number, over: Parameters<typeof assignedTrip>[1] = {}) {
      const t = await ticketed(w, over);
      await setAssignment(t.trip.id, { seenAt: minutesAgo(30), pickedUpAt: minutesAgo(25), customerWaitAt: minutesAgo(minutes) });
      return t.trip;
    }

    it("pasados customerWaitMinutes: le dice al motorizado que devuelva el pedido y le avisa al restaurante", async () => {
      const w = await world();
      const t = await waiting(w, 11);
      assert.deepEqual(await notify.closeCustomerWaits(), [t.id]);
      assert.ok((await getAssignment(t.id)).undeliveredAt);

      const [mine] = toCourier(w);
      assert.equal(mine.text, `⏰ El cliente del pedido ${t.code} no contestó. Devuélvelo a Pizza Nona y toca «Devolví el pedido».`);
      assert.deepEqual(mine.buttons.map((b) => b.id), [`returned:${t.id}`]);

      const [theirs] = toRestaurant(w);
      assert.equal(theirs.text, `⚠️ Pedido ${t.code}: el cliente no contestó en 10 minutos. El domiciliario te lo devuelve.`);
      assert.equal(theirs.replyTo, t.sourceWaMessageId);
    });

    it("antes de que venza no hace nada", async () => {
      const w = await world();
      const t = await waiting(w, 5);
      assert.deepEqual(await notify.closeCustomerWaits(), []);
      assert.equal(outbox.length, 0);
      assert.equal((await getAssignment(t.id)).undeliveredAt, null);
    });

    it("usa los minutos que configure la agencia, también en el aviso", async () => {
      const w = await world();
      await setBotConfig({ customerWaitMinutes: 3 });
      const t = await waiting(w, 4);
      assert.deepEqual(await notify.closeCustomerWaits(), [t.id]);
      assert.match(toRestaurant(w)[0].text, /no contestó en 3 minutos/);
    });

    it("lo cierra una sola vez, aunque corran dos ticks a la vez", async () => {
      const w = await world();
      const t = await waiting(w, 12);
      const [a, b] = await Promise.all([notify.closeCustomerWaits(), notify.closeCustomerWaits()]);
      assert.equal(a.length + b.length, 1);
      assert.deepEqual(await notify.closeCustomerWaits(), []);
      assert.equal(toCourier(w).length, 1);
      assert.equal(toRestaurant(w).length, 1);
      assert.ok((await getAssignment(t.id)).undeliveredAt);
    });

    it("sin conversación del restaurante, igual le avisa al motorizado", async () => {
      const w = await world();
      const t = await waiting(w, 12, { conversationId: null });
      assert.deepEqual(await notify.closeCustomerWaits(), [t.id]);
      assert.equal(toCourier(w).length, 1);
      assert.equal(toRestaurant(w).length, 0);
    });

    it("no toca lo que ya se entregó ni lo que ya no está en ruta", async () => {
      const w = await world();
      const done = await waiting(w, 12);
      await deliverTrip(done.id, { place: "customer" });
      const cancelled = await waiting(w, 12);
      await db.update(schema.trips).set({ status: "cancelled" }).where(eq(schema.trips.id, cancelled.id));
      outbox.length = 0;
      assert.deepEqual(await notify.closeCustomerWaits(), []);
      assert.equal(outbox.length, 0);
    });

    it("no vuelve sobre una espera que ya se cerró", async () => {
      const w = await world();
      const t = await waiting(w, 12);
      await setAssignment(t.id, { undeliveredAt: minutesAgo(1) });
      assert.deepEqual(await notify.closeCustomerWaits(), []);
    });

    it("sin cliente esperando no hace nada", async () => {
      const w = await world();
      await ticketed(w);
      assert.deepEqual(await notify.closeCustomerWaits(), []);
    });
  });

  describe("entrega y cierre del servicio (notifyDelivered / notifyFinished)", () => {
    async function delivered(w: World, place: "customer" | "gate") {
      const { trip: t } = await ticketed(w);
      await setAssignment(t.id, { seenAt: minutesAgo(10), pickedUpAt: minutesAgo(5) });
      await deliverTrip(t.id, { place });
      outbox.length = 0;
      return t;
    }

    it("a la entrega en el cliente: confirmación al motorizado y aviso al restaurante", async () => {
      const w = await world();
      const t = await delivered(w, "customer");
      await notify.notifyDelivered(t.id);
      assert.equal(toCourier(w)[0].text, `✅ ${t.code} terminado.`);
      assert.match(toRestaurant(w)[0].text, new RegExp(`^📦 Pedido ${t.code} entregado a las .+ ✅$`));
    });

    it("con el aviso de entrega apagado, el restaurante no recibe nada; el de portería sale siempre", async () => {
      const w = await world();
      await setBotConfig({ notifyRestaurantOnDelivery: false });
      const customer = await delivered(w, "customer");
      await notify.notifyDelivered(customer.id);
      assert.equal(toRestaurant(w).length, 0);
      const gate = await delivered(w, "gate");
      await notify.notifyDelivered(gate.id);
      assert.match(toRestaurant(w)[0].text, /quedó en portería/);
    });

    it("con la confirmación al motorizado apagada y sin pendientes, no le escribe", async () => {
      const w = await world();
      await setBotConfig({ confirmDeliveryToCourier: false });
      const t = await delivered(w, "customer");
      await notify.notifyDelivered(t.id);
      assert.equal(toCourier(w).length, 0);
    });

    it("con un datáfono pendiente de ese pedido, el mensaje de cierre dice cómo devolverlo, con su botón", async () => {
      const w = await world();
      const { trip: t, debt } = await debtWithDeliveredTrip(w, "datafono");
      outbox.length = 0;
      await notify.notifyFinished(t.id);
      const [msg] = toCourier(w);
      assert.match(plain(msg.text), new RegExp(`^✅ ${t.code} terminado\\.\\s*💳 Devuelve el datáfono en Pizza Nona \\(${t.code}\\)\\. Cuando lo hagas, toca «Ya lo devolví»\\.$`));
      assert.deepEqual(msg.buttons.map((b) => b.id), [`debtok:${debt.id}`]);
      assert.deepEqual(msg.buttons.map((b) => b.title), ["✅ Ya lo devolví"]);
      assert.ok((await getReturnDebt(debt.id))?.reminderAt);
    });

    it("el pendiente sale aunque la confirmación esté apagada, pero sin el «terminado»", async () => {
      const w = await world();
      await setBotConfig({ confirmDeliveryToCourier: false });
      const { trip: t } = await debtWithDeliveredTrip(w, "datafono");
      outbox.length = 0;
      await notify.notifyFinished(t.id);
      assert.ok(!toCourier(w)[0].text.includes("terminado"));
      assert.match(toCourier(w)[0].text, /Devuelve el datáfono/);
    });

    it("plata con demanda alta: queda anotada, sin meterla en su ruta", async () => {
      const w = await world();
      await setDemand("alta");
      const { trip: t, debt } = await debtWithDeliveredTrip(w, "plata");
      outbox.length = 0;
      await notify.notifyFinished(t.id);
      assert.match(plain(toCourier(w)[0].text), /Quedó anotado que le debes a Pizza Nona/);
      const [row] = await db.select().from(schema.returnDebts).where(eq(schema.returnDebts.id, debt.id));
      assert.equal(row.routedAt, null);
    });

    it("plata con demanda baja y la moto libre: «Aprovecha: pasa por X a pagar» y entra en su ruta", async () => {
      const w = await world();
      await setDemand("baja");
      const { trip: t, debt } = await debtWithDeliveredTrip(w, "plata");
      outbox.length = 0;
      await notify.notifyFinished(t.id);
      assert.match(plain(toCourier(w)[0].text), new RegExp(`💵 Aprovecha: pasa por Pizza Nona a pagar \\(${t.code}\\)\\. Cuando lo hagas, toca «Ya pagué»\\.`));
      const [row] = await db.select().from(schema.returnDebts).where(eq(schema.returnDebts.id, debt.id));
      assert.ok(row.routedAt);
    });

    it("plata con demanda baja pero con otro pedido encima: no la manda a pagar todavía", async () => {
      const w = await world();
      await setDemand("baja");
      const { trip: t } = await debtWithDeliveredTrip(w, "plata");
      await assignedTrip(w);
      outbox.length = 0;
      await notify.notifyFinished(t.id);
      assert.match(plain(toCourier(w)[0].text), /Quedó anotado que le debes/);
    });

    it("«devuelto» confirma sin hablar de pendientes", async () => {
      const w = await world();
      const { trip: t } = await ticketed(w);
      await notify.notifyFinished(t.id, "devuelto");
      assert.equal(toCourier(w)[0].text, `✅ ${t.code} devuelto.`);
    });
  });

  describe("avisos de pendientes a la central y al motorizado", () => {
    it("«Mandar ya» (notifyDebtNudge): le escribe al motorizado, mete la plata en su ruta y cierra el reclamo del restaurante", async () => {
      const w = await world();
      const { debt, trip: t } = await debtWithDeliveredTrip(w, "plata");
      await recordDebtClaim({ restaurantId: w.restaurant.id, restaurantName: "Pizza Nona", reason: "plata", closing: false, why: "x" });
      outbox.length = 0;
      assert.equal(await notify.notifyDebtNudge(debt.id), true);
      assert.equal(plain(toCourier(w)[0].text), `📢 Pasa por Pizza Nona a pagar lo que quedaste debiendo (${t.code}). Cuando lo hagas, toca «Ya pagué».`);
      assert.deepEqual(toCourier(w)[0].buttons.map((b) => b.id), [`debtok:${debt.id}`]);
      const [row] = await db.select().from(schema.returnDebts).where(eq(schema.returnDebts.id, debt.id));
      assert.ok(row.routedAt && row.reminderAt);
      assert.equal((await openDebtClaims()).length, 0);
    });

    it("«Mandar ya» sobre un pendiente que ya se cerró o no existe: false y no escribe", async () => {
      const w = await world();
      const { debt } = await debtWithDeliveredTrip(w, "plata");
      const { resolveReturnDebtGroup } = await import("@dispatch/shared/db");
      await resolveReturnDebtGroup(debt.id, { kind: "central", userId: null });
      outbox.length = 0;
      assert.equal(await notify.notifyDebtNudge(debt.id), false);
      assert.equal(await notify.notifyDebtNudge(99_999), false);
      assert.equal(outbox.length, 0);
    });

    it("nudgeIdlePayments(): con demanda baja y la moto libre, le avisa una sola vez que pase a pagar", async () => {
      const w = await world();
      await setDemand("baja");
      const { debt } = await debtWithDeliveredTrip(w, "plata");
      outbox.length = 0;
      assert.deepEqual(await notify.nudgeIdlePayments(), [debt.id]);
      assert.match(plain(toCourier(w)[0].text), /Aprovecha: pasa por Pizza Nona a pagar/);
      assert.deepEqual(await notify.nudgeIdlePayments(), [], "ya está en su ruta");
    });

    it("nudgeIdlePayments(): con demanda alta, o con la moto ocupada, no avisa", async () => {
      const w = await world();
      await debtWithDeliveredTrip(w, "plata");
      await setDemand("alta");
      outbox.length = 0;
      assert.deepEqual(await notify.nudgeIdlePayments(), []);
      await setDemand("baja");
      await assignedTrip(w);
      outbox.length = 0;
      assert.deepEqual(await notify.nudgeIdlePayments(), []);
      assert.equal(outbox.length, 0);
    });
  });

  describe("handleRestaurantDebtClaim(): el restaurante reclama su plata o su datáfono", () => {
    const claimFor = (w: World, claim: { reason: "datafono" | "plata" | null; closing: boolean }, over: Partial<Parameters<Notify["handleRestaurantDebtClaim"]>[0]> = {}) =>
      notify.handleRestaurantDebtClaim({
        conversationId: w.restaurantConversation.id,
        phone: w.restaurantConversation.phone,
        restaurantId: w.restaurant.id,
        restaurantName: "Pizza Nona",
        claim,
        replyTo: "wamid.claim.1",
        ...over,
      });
    const claims = () => db.select().from(schema.returnDebtClaims);

    describe("caso claro: se resuelve solo", () => {
      it("un motorizado conectado y libre con ese datáfono: se le avisa, se marca el reclamo y se le responde al restaurante", async () => {
        const w = await world();
        const { debt, trip: t } = await debtWithDeliveredTrip(w, "datafono");
        outbox.length = 0;
        const decision = await claimFor(w, { reason: "datafono", closing: false }, {});
        assert.equal(decision.kind, "auto");
        assert.equal(plain(toCourier(w)[0].text), `📢 Pizza Nona necesita su datáfono (${t.code}). Pasa por allá a devolverlo. Cuando lo hagas, toca «Ya lo devolví».`);
        assert.deepEqual(toCourier(w)[0].buttons.map((b) => b.id), [`debtok:${debt.id}`]);
        assert.equal(toRestaurant(w)[0].text, "Ya le avisamos a Pedro Gómez, va para allá 🛵");
        assert.equal(toRestaurant(w)[0].replyTo, "wamid.claim.1");
        assert.ok((await getReturnDebt(debt.id))?.claimedAt, "queda marcado que ya se avisó");
        assert.equal((await claims()).length, 0, "no se crea reclamo para la central");
      });

      it("con plata, además mete el regreso en su ruta", async () => {
        const w = await world();
        const { debt } = await debtWithDeliveredTrip(w, "plata");
        await claimFor(w, { reason: "plata", closing: false });
        const [row] = await db.select().from(schema.returnDebts).where(eq(schema.returnDebts.id, debt.id));
        assert.ok(row.routedAt);
        assert.match(plain(toCourier(w)[0].text), /Pizza Nona necesita su plata/);
        assert.match(plain(toCourier(w)[0].text), /Pasa por allá a pagar\. Cuando lo hagas, toca «Ya pagué»\./);
      });

      it("ocupado con demanda baja: igual va, pero apenas entregue lo que lleva", async () => {
        const w = await world();
        await setDemand("baja");
        await debtWithDeliveredTrip(w, "datafono");
        await assignedTrip(w);
        outbox.length = 0;
        const decision = await claimFor(w, { reason: "datafono", closing: false });
        assert.deepEqual([decision.kind, decision.kind === "auto" && decision.busy], ["auto", true]);
        assert.match(plain(toCourier(w)[0].text), /Pasa apenas entregues lo que llevas/);
      });

      it("ocupado con demanda alta pero el restaurante va a cerrar: se le avisa igual", async () => {
        const w = await world();
        await setDemand("alta");
        await debtWithDeliveredTrip(w, "datafono");
        await assignedTrip(w);
        outbox.length = 0;
        const decision = await claimFor(w, { reason: "datafono", closing: true });
        assert.equal(decision.kind, "auto");
        assert.match(plain(toCourier(w)[0].text), /\(van a cerrar\)\. Pasa apenas entregues lo que llevas\./);
      });

      it("reconoce al restaurante por su nombre si no tiene id, sin importar mayúsculas ni tildes", async () => {
        const w = await world({ restaurantName: "Café Nona" });
        await debtWithDeliveredTrip(w, "datafono", { restaurantName: "Café Nona", restaurantId: null });
        outbox.length = 0;
        const decision = await claimFor(w, { reason: "datafono", closing: false }, { restaurantId: null, restaurantName: "CAFE NONA" });
        assert.equal(decision.kind, "auto");
      });

      it("sin motivo (va a cerrar) y con datáfono y plata del mismo motorizado: avisa de cada grupo", async () => {
        const w = await world();
        await debtWithDeliveredTrip(w, "datafono");
        await debtWithDeliveredTrip(w, "plata");
        outbox.length = 0;
        const decision = await claimFor(w, { reason: null, closing: true });
        assert.equal(decision.kind, "auto");
        assert.equal(toCourier(w).length, 2);
        const texts = toCourier(w).map((m) => plain(m.text)).join(" | ");
        assert.match(texts, /su datáfono/);
        assert.match(texts, /su plata/);
        assert.equal(toRestaurant(w).length, 1, "al restaurante se le responde una sola vez");
      });
    });

    describe("cualquier otro caso: se registra para la central (/pendientes)", () => {
      it("no hay nada declarado: reclamo para la central y respuesta «lo está gestionando»", async () => {
        const w = await world();
        const decision = await claimFor(w, { reason: "datafono", closing: false });
        assert.deepEqual(decision, { kind: "central", why: "No hay ningún datáfono pendiente registrado (el domiciliario no lo declaró)." });
        const [row] = await claims();
        assert.deepEqual([row.restaurantName, row.restaurantId, row.reason, row.closing, row.conversationId, row.handledAt], ["Pizza Nona", w.restaurant.id, "datafono", false, w.restaurantConversation.id, null]);
        assert.equal(row.why, "No hay ningún datáfono pendiente registrado (el domiciliario no lo declaró).");
        assert.equal(toRestaurant(w)[0].text, "La central ya lo está gestionando 🙏");
        assert.equal(toRestaurant(w)[0].replyTo, "wamid.claim.1");
        assert.equal(toCourier(w).length, 0);
      });

      it("el mensaje de «no hay» nombra lo que reclamó: plata o cualquier pendiente", async () => {
        const w = await world();
        assert.equal((await claimFor(w, { reason: "plata", closing: false })).kind === "central" && (await claims())[0].why, "No hay plata pendiente registrada (el domiciliario no lo declaró).");
        await db.delete(schema.returnDebtClaims);
        const generic = await claimFor(w, { reason: null, closing: true });
        assert.deepEqual(generic, { kind: "central", why: "No hay ningún pendiente registrado (el domiciliario no lo declaró)." });
      });

      it("le deben varios domiciliarios", async () => {
        const w = await world();
        await debtWithDeliveredTrip(w, "datafono");
        const luis = await world({ courier: { name: "Luis Pérez" }, restaurantName: "Otra Pizza" });
        const { trip: t } = await assignedTrip(luis);
        await declareReturnDebt({ courierId: luis.courier.id, reason: "datafono", restaurantName: "Pizza Nona", restaurantId: w.restaurant.id, tripId: t.id, declaredBy: "courier" });
        outbox.length = 0;
        const decision = await claimFor(w, { reason: "datafono", closing: false });
        assert.deepEqual(decision, { kind: "central", why: "Le deben varios domiciliarios (Pedro Gómez y Luis Pérez)." });
        assert.equal(toCourier(w).length, 0);
        assert.equal(sentTo(luis.courier.phone).length, 0);
      });

      it("el motorizado está desconectado", async () => {
        const w = await world();
        await debtWithDeliveredTrip(w, "datafono");
        await db.update(schema.couriers).set({ status: "offline" }).where(eq(schema.couriers.id, w.courier.id));
        const decision = await claimFor(w, { reason: "datafono", closing: false });
        assert.deepEqual(decision, { kind: "central", why: "Pedro Gómez está desconectado." });
        assert.equal(toCourier(w).length, 0);
      });

      it("un motorizado desactivado de Flota cuenta como desconectado", async () => {
        const w = await world();
        await debtWithDeliveredTrip(w, "datafono");
        await db.update(schema.couriers).set({ active: false }).where(eq(schema.couriers.id, w.courier.id));
        assert.equal((await claimFor(w, { reason: "datafono", closing: false })).kind, "central");
      });

      it("está ocupado y la demanda es alta", async () => {
        const w = await world();
        await setDemand("alta");
        const { debt } = await debtWithDeliveredTrip(w, "datafono");
        await assignedTrip(w);
        outbox.length = 0;
        const decision = await claimFor(w, { reason: "datafono", closing: false });
        assert.deepEqual(decision, { kind: "central", why: "Pedro Gómez está ocupado con demanda alta." });
        assert.equal((await getReturnDebt(debt.id))?.claimedAt, null, "no se marca como avisado");
        assert.equal(toCourier(w).length, 0);
      });

      it("el restaurante reclama otra vez y ya se le había avisado", async () => {
        const w = await world();
        await debtWithDeliveredTrip(w, "datafono");
        assert.equal((await claimFor(w, { reason: "datafono", closing: false })).kind, "auto");
        outbox.length = 0;
        const again = await claimFor(w, { reason: "datafono", closing: false });
        assert.deepEqual(again, { kind: "central", why: "Ya se le había avisado a Pedro Gómez y el restaurante volvió a reclamar." });
        assert.equal(toCourier(w).length, 0, "no se le insiste al motorizado");
        assert.equal(toRestaurant(w)[0].text, "La central ya lo está gestionando 🙏");
        assert.equal((await claims()).length, 1);
      });

      it("lo de otro restaurante o ya cerrado no cuenta", async () => {
        const w = await world();
        await debtWithDeliveredTrip(w, "datafono", { restaurantName: "Donde Lucho", restaurantId: null });
        const { debt } = await debtWithDeliveredTrip(w, "plata");
        const { resolveReturnDebtGroup } = await import("@dispatch/shared/db");
        await resolveReturnDebtGroup(debt.id, { kind: "central", userId: null });
        const decision = await claimFor(w, { reason: "datafono", closing: false });
        assert.equal(decision.kind, "central");
        assert.match(decision.kind === "central" ? decision.why : "", /No hay ningún datáfono pendiente/);
        assert.equal((await openReturnDebts()).length, 1, "lo de Donde Lucho sigue abierto");
      });

      it("un segundo reclamo del mismo restaurante actualiza el que ya hay, no apila otro", async () => {
        const w = await world();
        await claimFor(w, { reason: "datafono", closing: false });
        await claimFor(w, { reason: null, closing: true });
        const rows = await claims();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].closing, true, "ahora avisa que va a cerrar");
        assert.equal(rows[0].reason, "datafono", "conserva el motivo si el nuevo no trae uno");
        assert.equal((await openDebtClaims()).length, 1);
      });

      it("cuando la central resuelve el pendiente, el reclamo se cierra", async () => {
        const w = await world();
        const { debt } = await debtWithDeliveredTrip(w, "plata");
        await db.update(schema.couriers).set({ status: "offline" }).where(eq(schema.couriers.id, w.courier.id));
        await claimFor(w, { reason: "plata", closing: false });
        assert.equal((await openDebtClaims()).length, 1);
        const { resolveReturnDebtGroup } = await import("@dispatch/shared/db");
        await resolveReturnDebtGroup(debt.id, { kind: "central", userId: null });
        assert.equal((await openDebtClaims()).length, 0);
      });
    });
  });

  describe("remindClosingDebts(): antes de la hora límite del restaurante", () => {
    /** 23:10 en Cali: faltan 20 minutos para las 23:30 (la hora límite por defecto). */
    const NEAR_CLOSE = new Date("2026-11-11T04:10:00Z");
    /** 8:00 p. m. en Cali: falta mucho. */
    const EARLY = new Date("2026-11-11T01:00:00Z");

    it("avisa una sola vez, con el mismo caso claro que el reclamo", async () => {
      const w = await world();
      const { debt, trip: t } = await debtWithDeliveredTrip(w, "datafono");
      outbox.length = 0;
      assert.deepEqual(await notify.remindClosingDebts(NEAR_CLOSE), [debt.id]);
      assert.equal(plain(toCourier(w)[0].text), `⏰ Pizza Nona cierra pronto: pasa a devolver el datáfono (${t.code}). Cuando lo hagas, toca «Ya lo devolví».`);
      assert.deepEqual(toCourier(w)[0].buttons.map((b) => b.id), [`debtok:${debt.id}`]);
      assert.ok((await getReturnDebt(debt.id))?.closingNotifiedAt);
      assert.deepEqual(await notify.remindClosingDebts(NEAR_CLOSE), []);
      assert.equal(toCourier(w).length, 1);
    });

    it("si todavía falta mucho para cerrar, no avisa", async () => {
      const w = await world();
      await debtWithDeliveredTrip(w, "datafono");
      outbox.length = 0;
      assert.deepEqual(await notify.remindClosingDebts(EARLY), []);
      assert.equal(outbox.length, 0);
    });

    it("usa la hora límite propia del restaurante", async () => {
      const w = await world();
      await db.update(schema.restaurants).set({ orderDeadline: "20:30" }).where(eq(schema.restaurants.id, w.restaurant.id));
      const { debt } = await debtWithDeliveredTrip(w, "datafono");
      // 8:00 p. m.: faltan 30 para las 20:30, justo en la ventana (closingDebtMinutes = 30).
      assert.deepEqual(await notify.remindClosingDebts(EARLY), [debt.id]);
    });

    it("si ya se le avisó por un reclamo, no se le repite; si el motorizado está desconectado, no se le escribe", async () => {
      const w = await world();
      await debtWithDeliveredTrip(w, "datafono");
      await claimClear(w);
      outbox.length = 0;
      assert.deepEqual(await notify.remindClosingDebts(NEAR_CLOSE), [], "ya reclamado");

      const z = await world({ restaurantName: "Otra" });
      await debtWithDeliveredTrip(z, "datafono", { restaurantName: "Otra", restaurantId: z.restaurant.id });
      await db.update(schema.couriers).set({ status: "offline" }).where(eq(schema.couriers.id, z.courier.id));
      outbox.length = 0;
      assert.deepEqual(await notify.remindClosingDebts(NEAR_CLOSE), []);
      assert.equal(outbox.length, 0);
    });

    it("sin pendientes no hace nada", async () => {
      assert.deepEqual(await notify.remindClosingDebts(NEAR_CLOSE), []);
    });

    /** Marca el reclamo como ya avisado, como lo deja `handleRestaurantDebtClaim`. */
    async function claimClear(w: World) {
      await notify.handleRestaurantDebtClaim({
        conversationId: w.restaurantConversation.id,
        phone: w.restaurantConversation.phone,
        restaurantId: w.restaurant.id,
        restaurantName: "Pizza Nona",
        claim: { reason: "datafono", closing: false },
      });
    }
  });

  describe("configuración de Traccar por WhatsApp (notifyCourierGpsConfig)", () => {
    async function withGps(w: World, deviceId: string | null = "gps-abc123") {
      if (deviceId) await db.insert(schema.courierProfiles).values({ courierId: w.courier.id, gpsDeviceId: deviceId });
    }
    const inWindow = (w: World, at = new Date()) => db.update(schema.conversations).set({ lastInboundAt: at }).where(eq(schema.conversations.id, w.courierConversation.id));

    it("motorizado que no existe, sin identificador de GPS o sin URL: lo dice", async () => {
      const w = await world();
      assert.deepEqual(await notify.notifyCourierGpsConfig(99_999, "https://x/api/gps"), { ok: false, reason: "not_found" });
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id, "https://x/api/gps"), { ok: false, reason: "no_gps_id" });
      await withGps(w);
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id), { ok: false, reason: "no_url" });
      assert.equal(outbox.length, 0);
    });

    it("fuera de la ventana de 24 horas de WhatsApp: outside_window y no envía", async () => {
      const w = await world();
      await withGps(w);
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id, "https://x/api/gps"), { ok: false, reason: "outside_window" });
      await inWindow(w, new Date(Date.now() - 25 * 60 * 60_000));
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id, "https://x/api/gps"), { ok: false, reason: "outside_window" });
      assert.equal(outbox.length, 0);
    });

    it("dentro de la ventana: envía el identificador y la URL", async () => {
      const w = await world();
      await withGps(w);
      await inWindow(w);
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id, "https://bot.example/api/gps"), { ok: true });
      const text = toCourier(w)[0].text;
      assert.ok(text.includes("gps-abc123"));
      assert.ok(text.includes("https://bot.example/api/gps"));
    });

    it("sin URL explícita usa el host del bot", async () => {
      const w = await world();
      await withGps(w);
      await inWindow(w);
      process.env.BOT_HOST = "https://bot.clapi.example/";
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id), { ok: true });
      assert.ok(toCourier(w)[0].text.includes("https://bot.clapi.example/api/gps"));
    });

    it("en el WhatsApp simulado no hace falta la ventana", async () => {
      const w = await world();
      await withGps(w);
      process.env.WHATSAPP_SIMULADO = "true";
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id, "https://x/api/gps"), { ok: true });
    });

    it("si Meta responde «fuera de ventana» (131047) o falla el envío, lo distingue", async () => {
      const w = await world();
      await withGps(w);
      await inWindow(w);
      whatsapp.failSends(true, { error: { code: 131047 } });
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id, "https://x/api/gps"), { ok: false, reason: "outside_window" });
      whatsapp.failSends(true, { error: { code: 100 } });
      assert.deepEqual(await notify.notifyCourierGpsConfig(w.courier.id, "https://x/api/gps"), { ok: false, reason: "send_failed" });
    });
  });

  describe("quitado de la flota (notifyCourierRemoved)", () => {
    it("le avisa que la central lo quitó y cómo pedir volver", async () => {
      const courier = await createCourier({ name: "Lauri Gómez", active: false, status: "offline" });
      await notify.notifyCourierRemoved(courier.id);
      const sent = outbox.filter((m) => m.phone === courier.phone);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /^Lauri, la central te quitó de la flota/);
    });

    it("no avisa a uno que sigue en la flota, a una moto simulada ni a uno que no existe", async () => {
      const active = await createCourier({ name: "Activo" });
      const simulated = await createCourier({ name: "Simulada", active: false, simulated: true });
      for (const id of [active.id, simulated.id, 99_999]) await notify.notifyCourierRemoved(id);
      assert.equal(outbox.length, 0);
    });
  });
});
