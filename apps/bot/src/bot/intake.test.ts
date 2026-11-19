import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema, setBusinessPaused, saveFareRanges, setServiceHours } from "@dispatch/shared/db";
import { closeTestDatabase, createCourier, createRestaurant, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  getAssignment,
  getTrip,
  installMocks,
  marked,
  outbox,
  plain,
  resetMocks,
  restoreMocks,
  sentTo,
  world,
  PICKUP,
  type World,
} from "@/test-support/bot-env";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * `intake.ts`: por el mismo número escriben motorizados y restaurantes, y esto
 * decide a quién va cada mensaje. Se prueba el enrutamiento (motorizado o
 * restaurante, la pausa general, el chat tomado por un asesor, el modo
 * simulador) y la espera con que el bot junta los mensajes seguidos de un
 * restaurante en una sola respuesta. WhatsApp, OpenAI y Google, simulados;
 * lo demás es la base de pruebas. Sin `TEST_DATABASE_URL` se salta.
 */

type Intake = typeof import("./intake");
let intake: Intake;
const modelCalls: string[] = [];

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  const extract = await import("@/services/openai/extract");
  mock.module("@/services/openai/extract", {
    namedExports: {
      ...extract,
      interpretMessage: async (text: string) => {
        modelCalls.push(text);
        return {
          fields: {
            origenRestaurante: null,
            nombreRestaurante: null,
            entregas: [
              {
                direccionEntrega: "Calle 10 # 5-20",
                telefonoCliente: "3001234567",
                nombreCliente: "Marta Ríos",
                valorACobrar: null,
                metodoPago: null,
                listoEnMinutos: 10,
                notas: null,
                detalleDireccion: null,
                esConjunto: null,
                barrio: null,
                dudas: null,
              },
            ],
          },
          query: null,
          intent: null,
          confirms: false,
          confused: false,
          failed: false,
          claim: null,
        };
      },
    },
  });
  const geocode = await import("@/services/google/geocode");
  mock.module("@/services/google/geocode", {
    namedExports: { ...geocode, geocodeAddress: async () => ({ kind: "found", location: { lat: 3.46, lng: -76.53 }, neighborhood: "Ciudad Jardín" }) },
  });
  intake = await import("./intake");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  modelCalls.length = 0;
  delete process.env.SIMULATOR_ENABLED;
  // Abierto todo el día: sin esto, la prueba de la espera falla de noche («ya no recibimos servicios»).
  await setServiceHours({ opensAt: "00:00", defaultDeadline: "00:00" });
  await saveFareRanges([
    { upToKm: 3, price: 5_000 },
    { upToKm: null, price: 8_000 },
  ]);
});

let inbound = 0;
const from = (phone: string, rest: Partial<IncomingMessage> & ({ kind: "text"; text: string } | { kind: "button"; buttonId: string; title: string })): IncomingMessage =>
  ({ waMessageId: `wamid.in.${++inbound}`, phone, profileName: null, timestamp: new Date(), ...rest }) as IncomingMessage;
const text = (phone: string, t: string) => from(phone, { kind: "text", text: t });
const button = (phone: string, id: string) => from(phone, { kind: "button", buttonId: id, title: id });

const messagesOf = (conversationId: number) => db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.id);
const conversationByPhone = async (phone: string) => (await db.select().from(schema.conversations).where(eq(schema.conversations.phone, phone)))[0];

describe("intake.ts: a quién va cada mensaje (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("motorizados", () => {
    it("un botón suyo se atiende en el acto, se marca leído (sin «escribiendo…») y queda en su chat", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      const message = button(w.courier.phone, `picked:${trip.id}`);
      const started = Date.now();
      await intake.handleIncoming(message);
      assert.ok(Date.now() - started < 2_000, "al motorizado no se le hace esperar");
      assert.ok((await getAssignment(trip.id)).pickedUpAt, "marcó la recogida");
      assert.deepEqual(marked, [{ wamid: message.waMessageId, typing: false }]);
      const [stored] = await messagesOf(w.courierConversation.id);
      assert.equal(stored.waMessageId, message.waMessageId);
      assert.equal(stored.text, `[Botón] picked:${trip.id}`);
      assert.deepEqual(stored.incoming, { kind: "button", buttonId: `picked:${trip.id}`, title: `picked:${trip.id}`, replyTo: null });
      assert.equal(modelCalls.length, 0, "no pasa por el modelo del restaurante");
    });

    it("su texto va a courier.ts, no a order.ts", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      await intake.handleIncoming(text(w.courier.phone, "ya recogí"));
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
      assert.equal(modelCalls.length, 0);
    });

    it("lo reconoce por los últimos 10 dígitos del wa_id", async () => {
      const w = await world({ courier: { phone: "3001234567" } });
      const { trip } = await assignedTrip(w);
      await intake.handleIncoming(button("573001234567", `picked:${trip.id}`));
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
    });

    it("sus botones funcionan aunque la central haya tomado su chat; su texto, no", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      await db.update(schema.conversations).set({ botPaused: true }).where(eq(schema.conversations.id, w.courierConversation.id));
      await intake.handleIncoming(text(w.courier.phone, "ya recogí"));
      assert.equal((await getAssignment(trip.id)).pickedUpAt, null);
      await intake.handleIncoming(button(w.courier.phone, `picked:${trip.id}`));
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
    });
  });

  describe("pausa general de la agencia", () => {
    it("el bot no le responde a nadie: queda el mensaje en el chat y nada más", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      await setBusinessPaused(true);
      await intake.handleIncoming(text(w.courier.phone, "ya recogí"));
      assert.equal((await getAssignment(trip.id)).pickedUpAt, null);
      assert.equal(outbox.length, 0);
      assert.equal(marked.length, 0);
      assert.equal((await messagesOf(w.courierConversation.id)).length, 1, "el mensaje se guarda para la central");
    });

    it("pero lo que el motorizado marca con sus botones sigue funcionando, para cerrar lo que ya está en la calle", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      await setBusinessPaused(true);
      await intake.handleIncoming(button(w.courier.phone, `picked:${trip.id}`));
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
      await intake.handleIncoming(button(w.courier.phone, `done:customer:finish:${trip.id}`));
      assert.equal((await getTrip(trip.id)).status, "delivered");
    });

    it("un botón que no es del flujo del motorizado no cuenta como cierre", async () => {
      const w = await world();
      await setBusinessPaused(true);
      await intake.handleIncoming(button(w.courier.phone, "confirmar"));
      assert.equal(outbox.length, 0);
      assert.equal(marked.length, 0);
    });

    it("a un restaurante no le responde ni le marca leído", async () => {
      const restaurant = await createRestaurant({ name: "Pizza Nona", knownPickupLocation: PICKUP, knownPickupAddress: "Calle 5 # 38-10" });
      await setBusinessPaused(true);
      await intake.handleIncoming(text(restaurant.phone!, "hola, un domi"));
      assert.equal(outbox.length, 0);
      assert.equal(marked.length, 0);
      assert.equal(modelCalls.length, 0);
      assert.equal((await messagesOf((await conversationByPhone(restaurant.phone!)).id)).length, 1);
    });

    it("al reanudar, el bot vuelve a atender", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      await setBusinessPaused(true);
      await setBusinessPaused(false);
      await intake.handleIncoming(text(w.courier.phone, "ya recogí"));
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
    });
  });

  describe("restaurantes", () => {
    it("con un asesor al frente del chat, el bot escucha y calla: ni responde ni marca leído", async () => {
      const restaurant = await createRestaurant({ name: "Pizza Nona", knownPickupLocation: PICKUP, knownPickupAddress: "Calle 5 # 38-10" });
      await db.insert(schema.conversations).values({ phone: restaurant.phone!, botPaused: true, escalationReason: "x" });
      const started = Date.now();
      await intake.handleIncoming(text(restaurant.phone!, "hola"));
      assert.ok(Date.now() - started < 2_000, "ni siquiera espera");
      assert.equal(outbox.length, 0);
      assert.equal(marked.length, 0);
      assert.equal(modelCalls.length, 0);
      assert.equal((await messagesOf((await conversationByPhone(restaurant.phone!)).id)).length, 1);
    });

    it("espera y junta los mensajes seguidos: lee todo junto y responde una sola vez", { timeout: 20_000 }, async () => {
      const restaurant = await createRestaurant({ name: "Pizza Nona", knownPickupLocation: PICKUP, knownPickupAddress: "Calle 5 # 38-10" });
      const phone = restaurant.phone!;
      const first = text(phone, "Calle 10 # 5-20");
      const second = text(phone, "Marta Ríos, 3001234567");
      const started = Date.now();
      await Promise.all([intake.handleIncoming(first), new Promise((r) => setTimeout(r, 500)).then(() => intake.handleIncoming(second))]);
      assert.ok(Date.now() - started >= intake.REPLY_DELAY_MS, "espera antes de responder");
      assert.deepEqual(modelCalls, ["Calle 10 # 5-20\nMarta Ríos, 3001234567"], "el modelo lee los dos como un solo turno");
      assert.equal(sentTo(phone).length, 1, "una sola respuesta");
      assert.match(plain(sentTo(phone)[0].text), /Serían \$ ?5\.000/);
      assert.equal(sentTo(phone)[0].replyTo, first.waMessageId, "cita el primer mensaje del turno");
      // El primero se retira al ver que llegó otro; el segundo lo marca leído y «escribiendo…».
      assert.deepEqual(marked.map((m) => m.wamid), [second.waMessageId, second.waMessageId]);
      assert.deepEqual(marked.map((m) => m.typing), [false, true]);
      const conversation = await conversationByPhone(phone);
      const stored = await messagesOf(conversation.id);
      assert.equal(conversation.processedThroughMessageId, stored.filter((m) => m.role === "restaurant").at(-1)?.id, "quedó procesado hasta el último");
    });

    it("un número no registrado recibe un único aviso y pasa a la central sin gastar OpenAI", async () => {
      const stranger = "573009998877";
      const started = Date.now();
      await intake.handleIncoming(text(stranger, "hola quiero un domicilio"));
      assert.ok(Date.now() - started < 2_000, "no espera ni llama a OpenAI");
      assert.equal(modelCalls.length, 0);
      assert.equal(sentTo(stranger).length, 1);
      const conv = await conversationByPhone(stranger);
      assert.equal(conv.botPaused, true);
      assert.equal(conv.escalationReason, intake.UNKNOWN_NUMBER_REASON);

      // Si vuelve a escribir mientras sigue pausado, el bot se mantiene callado.
      await intake.handleIncoming(text(stranger, "¿hola?"));
      assert.equal(sentTo(stranger).length, 1);
      assert.equal(modelCalls.length, 0);
    });

    it("un restaurante inactivo tampoco pide y pasa a la central", async () => {
      const inactive = await createRestaurant({ name: "Cerrado", active: false, knownPickupLocation: PICKUP });
      await intake.handleIncoming(text(inactive.phone!, "un domi porfa"));
      assert.equal(modelCalls.length, 0);
      assert.equal(sentTo(inactive.phone!).length, 1);
      assert.equal((await conversationByPhone(inactive.phone!)).botPaused, true);
    });
  });

  describe("modo simulador (staging)", () => {
    async function simulation(w: World) {
      const sim = await createCourier({ name: "Moto sim 1", status: "busy", simulated: true });
      const tester = await createCourier({ name: "Probador", status: "available" });
      await db.insert(schema.simulatorControls).values({ phoneCourierId: tester.id, simCourierId: sim.id });
      const { trip } = await assignedTrip(w, {}, { courier: sim });
      return { sim, tester, trip };
    }

    it("un número de prueba que toca un botón actúa en nombre de la moto simulada que controla", async () => {
      process.env.SIMULATOR_ENABLED = "1";
      const w = await world();
      const { sim, tester, trip } = await simulation(w);
      await intake.handleIncoming(button(tester.phone, `picked:${trip.id}`));
      assert.ok((await getAssignment(trip.id)).pickedUpAt, "la recogida es de la moto simulada");
      assert.equal(sentTo(sim.phone).length, 1, "el mensaje 2 queda en el chat de la moto");
      assert.equal(sentTo(tester.phone).length, 0);
      assert.ok((await messagesOf((await conversationByPhone(sim.phone)).id)).length >= 1, "lo que tocó queda en el chat de la moto");
    });

    it("también por texto: «ya recogí» lo hace la moto que controla", async () => {
      process.env.SIMULATOR_ENABLED = "1";
      const w = await world();
      const { tester, trip } = await simulation(w);
      await intake.handleIncoming(text(tester.phone, "ya recogí"));
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
    });

    it("sin el simulador encendido, el mismo botón no es suyo", async () => {
      process.env.SIMULATOR_ENABLED = "1"; // la moto simulada solo recibe pedidos con el simulador encendido
      const w = await world();
      const { tester, trip } = await simulation(w);
      delete process.env.SIMULATOR_ENABLED;
      await intake.handleIncoming(button(tester.phone, `picked:${trip.id}`));
      assert.equal((await getAssignment(trip.id)).pickedUpAt, null);
      assert.equal(plain(sentTo(tester.phone)[0].text), "Ese servicio ya no está a tu nombre 🙏");
    });

    it("un número de prueba que no controla ninguna moto se atiende como siempre", async () => {
      process.env.SIMULATOR_ENABLED = "1";
      const w = await world();
      const { trip } = await assignedTrip(w, {}, { courier: await createCourier({ name: "Moto sim 2", status: "busy", simulated: true }) });
      await intake.handleIncoming(button(w.courier.phone, `picked:${trip.id}`));
      assert.equal(plain(sentTo(w.courier.phone)[0].text), "Ese servicio ya no está a tu nombre 🙏");
    });
  });
});
