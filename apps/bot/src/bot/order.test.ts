import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { eq } from "drizzle-orm";

import { ERRAND_RECEIVED_MESSAGE, ESCALATION_MESSAGE, MAX_CLARIFICATION_ATTEMPTS, normalizeDraft, type Interpretation, type OrderDraft } from "@dispatch/shared";
import { db, schema, saveFareRanges, createServiceZone, type Restaurant } from "@dispatch/shared/db";
import {
  closeTestDatabase,
  createConversation,
  createRestaurant,
  createTrip,
  integrationSkip,
  resetDatabase,
} from "@dispatch/shared/db/test-db";

import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * La máquina de estados del restaurante (`order.ts`), de punta a punta y sin
 * red: lo que se simula es lo que sale del proceso (OpenAI, WhatsApp, Google y
 * el engine); la conversación, los viajes, las tarifas, las zonas y el horario
 * son los de verdad, en un Postgres de pruebas (`@dispatch/shared/db/test-db`).
 * Así cada prueba comprueba lo que quedó guardado (`botPaused`,
 * `escalationReason`, el borrador, los viajes) y lo que se le contestó al
 * restaurante, no solo qué función se llamó.
 *
 * Sin `TEST_DATABASE_URL` se salta, como el resto de la integración
 * (docs/OPERACION.md, «Pruebas de integración»); en CI corre siempre.
 *
 * Cómo leer una prueba: `chat.say(texto, interpretación)` es un mensaje del
 * restaurante junto con lo que «entendió» el modelo; `chat.press(botón)`, un
 * botón; `chat.reply` es lo que el bot contestó.
 */

// ---------------------------------------------------------------------------
// Lo que sale del proceso, simulado
// ---------------------------------------------------------------------------

type Outcome = Awaited<ReturnType<(typeof import("@/services/openai/extract"))["interpretMessage"]>>;
type Geocode = Awaited<ReturnType<(typeof import("@/services/google/geocode"))["geocodeAddress"]>>;
type Fields = Interpretation["entregas"][number];

type Sent = { phone: string; text: string; buttons: { id: string; title: string }[]; replyTo: string | null };

const outbox: Sent[] = [];
const modelQueue: Outcome[] = [];
const modelCalls: { text: string; draft: OrderDraft }[] = [];
const geocodeCalls: string[] = [];
const geocodes = new Map<string, Geocode>();
const dispatched: number[] = [];
let nameScores: ((name: string, candidates: { id: number; name: string }[]) => Map<number, number> | null) | null = null;
let quoteOverride: ((...args: unknown[]) => unknown) | null = null;
/** Si la foto del mensaje se puede descargar (por defecto no). */
let photoAvailable = false;
let sentSeq = 0;

/** Donde cae lo que no se configura: dentro de Cali, a 1,4 km de la recogida (precio de la primera banda). */
const PICKUP = { lat: 3.45, lng: -76.53 };
const NEAR = { lat: 3.46, lng: -76.53 };
/** A ~7 km por calle de la recogida: segunda banda de la tabla. */
const FAR = { lat: 3.5, lng: -76.53 };
const PRICE_NEAR = 5_000;
const PRICE_FAR = 8_000;

type Order = typeof import("./order");
type Advisor = typeof import("./advisor");
type Turns = typeof import("./turns");
let order: Order;
let advisor: Advisor;
let turns: Turns;

before(async () => {
  if (integrationSkip) return;
  // Sin llaves: ni el router de calles ni Google se llaman aunque el equipo las tenga.
  for (const key of ["GOOGLE_MAPS_API_KEY", "OSRM_URL", "OPENAI_API_KEY"]) delete process.env[key];

  const whatsapp = await import("@/services/whatsapp/client");
  const extract = await import("@/services/openai/extract");
  const match = await import("@/services/openai/restaurant-match");
  const geocode = await import("@/services/google/geocode");
  const engine = await import("@/dispatch/engine");
  const shared = await import("@dispatch/shared/db");

  const record = (phone: string, text: string, buttons: { id: string; title: string }[] = [], replyTo: string | null = null) => {
    outbox.push({ phone, text, buttons, replyTo });
    return { ok: true as const, messageId: `wamid.out.${++sentSeq}` };
  };
  mock.module("@/services/whatsapp/client", {
    namedExports: {
      ...whatsapp,
      sendText: async (phone: string, text: string, o?: { replyTo?: string | null }) => record(phone, text, [], o?.replyTo ?? null),
      sendButtons: async (phone: string, text: string, buttons: { id: string; title: string }[], o?: { replyTo?: string | null }) =>
        record(phone, text, buttons, o?.replyTo ?? null),
      sendList: async (phone: string, text: string, _list: unknown, o?: { replyTo?: string | null }) => record(phone, text, [], o?.replyTo ?? null),
      downloadImage: async () => (photoAvailable ? { mimeType: "image/jpeg", base64: "AAAA" } : null),
      markRead: async () => {},
      markReadAndTyping: async () => {},
    },
  });
  mock.module("@/services/openai/extract", {
    namedExports: {
      ...extract,
      interpretMessage: async (text: string, draft: OrderDraft) => {
        modelCalls.push({ text, draft: structuredClone(draft) });
        const next = modelQueue.shift();
        if (!next) throw new Error(`El modelo no tenía respuesta preparada para: «${text}»`);
        return next;
      },
    },
  });
  mock.module("@/services/openai/restaurant-match", {
    namedExports: { ...match, scoreRestaurantName: async (name: string, candidates: { id: number; name: string }[]) => nameScores?.(name, candidates) ?? null },
  });
  mock.module("@/services/google/geocode", {
    namedExports: {
      ...geocode,
      geocodeAddress: async (address: string): Promise<Geocode> => {
        geocodeCalls.push(address);
        return geocodes.get(address) ?? { kind: "found", location: NEAR, neighborhood: "Ciudad Jardín" };
      },
    },
  });
  mock.module("@/dispatch/engine", {
    namedExports: {
      ...engine,
      dispatchTrip: async (tripId: number) => {
        dispatched.push(tripId);
        return false;
      },
    },
  });
  // Solo el router de calles se puede cambiar (caso «sin ruta»); lo demás es la base de verdad.
  mock.module("@dispatch/shared/db", {
    namedExports: {
      ...shared,
      quoteByDistance: (...args: Parameters<typeof shared.quoteByDistance>) => (quoteOverride ? quoteOverride(...args) : shared.quoteByDistance(...args)),
    },
  });

  order = await import("./order");
  advisor = await import("./advisor");
  turns = await import("./turns");
});

// ---------------------------------------------------------------------------
// Armar lo que dice el restaurante y lo que entiende el modelo
// ---------------------------------------------------------------------------

const PHONE = "573001112233";
/** 3 p. m. en Cali (UTC−5): dentro del horario de 10:00 a 23:30. */
const OPEN_AT = Date.parse("2026-11-10T20:00:00Z");
/** 3 a. m. en Cali: fuera de horario. */
const CLOSED_AT = Date.parse("2026-11-11T08:00:00Z");
/** 7 a. m. en Cali: ya es de mañana, pero todavía no abren (10:00). */
const MORNING_AT = Date.parse("2026-11-11T12:00:00Z");

const delivery = (over: Partial<Fields> = {}): Fields => ({
  direccionEntrega: null,
  telefonoCliente: null,
  nombreCliente: null,
  valorACobrar: null,
  metodoPago: null,
  listoEnMinutos: null,
  notas: null,
  detalleDireccion: null,
  esConjunto: null,
  barrio: null,
  dudas: null,
  ...over,
});

/** Un pedido completo: con esto el bot ya puede cotizar y mostrar el botón. */
const complete = (over: Partial<Fields> = {}): Fields =>
  delivery({ direccionEntrega: "Calle 10 # 5-20", nombreCliente: "Marta Ríos", telefonoCliente: "3001234567", listoEnMinutos: 10, ...over });

type Said = Partial<Pick<Outcome, "query" | "intent" | "confirms" | "confused" | "failed" | "errand" | "cancel">> & { nombreRestaurante?: string | null; quitar?: number[]; origen?: string | null };

/** Lo que devuelve el modelo: la lista completa de entregas hasta ahora. */
const understood = (entregas: Fields[], said: Said = {}): Outcome => ({
  fields: { origenRestaurante: said.origen ?? null, nombreRestaurante: said.nombreRestaurante ?? null, entregas, ...(said.quitar ? { quitar: said.quitar } : {}) },
  query: said.query ?? null,
  intent: said.intent ?? null,
  confirms: said.confirms ?? false,
  confused: said.confused ?? false,
  failed: said.failed ?? false,
  claim: null,
  errand: said.errand ?? null,
  cancel: said.cancel ?? null,
});

let clock = OPEN_AT;
let inboundSeq = 0;

type Extra = { replyTo?: string | null; at?: Date; profileName?: string | null };

/** El chat de un número con el bot, tal como lo arma `intake.ts`: relee la conversación y, si el bot está pausado, no contesta. */
function chat(phone = PHONE) {
  async function deliver(build: (head: Pick<IncomingMessage, "waMessageId" | "phone" | "profileName" | "timestamp" | "replyTo">) => IncomingMessage, extra: Extra = {}) {
    const { upsertConversationOnInbound } = await import("@/db/queries/conversation");
    const { findRestaurantByPhone } = await import("@dispatch/shared/db");
    const since = outbox.length;
    const timestamp = extra.at ?? new Date((clock += 15_000));
    const message = build({ waMessageId: `wamid.in.${++inboundSeq}`, phone, profileName: extra.profileName ?? null, timestamp, replyTo: extra.replyTo ?? null });
    const conversation = await upsertConversationOnInbound(phone, message.profileName);
    if (conversation.botPaused) return { silent: true, sent: [] as Sent[], message };
    await order.handleRestaurant({ conversation, message, restaurant: await findRestaurantByPhone(phone) });
    return { silent: false, sent: outbox.slice(since), message };
  }

  const api = {
    phone,
    /** Un mensaje de texto y lo que el modelo entendió de él. */
    async say(text: string, outcome: Outcome, extra: Extra = {}) {
      modelQueue.push(outcome);
      return deliver((head) => ({ ...head, kind: "text", text }), extra);
    },
    /** Un mensaje de texto que el modelo ni siquiera llega a leer (no hay respuesta preparada). */
    async raw(build: Parameters<typeof deliver>[0], extra: Extra = {}) {
      return deliver(build, extra);
    },
    /** Una foto (con o sin texto) y lo que el modelo leyó de ella. */
    async photo(caption: string, outcome: Outcome, extra: Extra = {}) {
      photoAvailable = true;
      modelQueue.push(outcome);
      return deliver((head) => ({ ...head, kind: "text", text: caption, images: ["media-1"] }), extra);
    },
    async press(buttonId: string, extra: Extra = {}) {
      return deliver((head) => ({ ...head, kind: "button", buttonId, title: buttonId }), extra);
    },
    async pin(lat: number, lng: number, label: string | null = null, extra: Extra = {}) {
      return deliver((head) => ({ ...head, kind: "location", lat, lng, label }), extra);
    },
    /** Lo último que el bot contestó, sin espacios raros y sin el saludo del día. */
    get reply() {
      return ungreeted(plain(outbox[outbox.length - 1]?.text ?? ""));
    },
    get replyButtons(): { id: string; title: string }[] {
      return outbox[outbox.length - 1]?.buttons ?? [];
    },
    /** La conversación como quedó en la base. */
    async conversation() {
      const [row] = await db.select().from(schema.conversations).where(eq(schema.conversations.phone, phone));
      return row;
    },
    async draft() {
      const row = await api.conversation();
      return row?.draft ? normalizeDraft(row.draft) : null;
    },
  };
  return api;
}

/** `$ 5.000` sale con espacio duro en es-CO: se compara con espacio normal. */
const plain = (s: string) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
/** El saludo del día (#121) encabeza la primera respuesta de cada prueba. Las
 *  comparaciones de siempre lo quitan; las del saludo miran el texto completo. */
const ungreeted = (s: string) => s.replace(/^¡Buen(os días|as tardes|as noches)! Gracias por confiar en Express Cali 🙌 /u, "");
const texts = (sent: Sent[]) => sent.map((s) => ungreeted(plain(s.text)));

const allTrips = () => db.select().from(schema.trips).orderBy(schema.trips.id);

async function registered(over: Partial<Restaurant> = {}) {
  return createRestaurant({ name: "Pizza Nona", phone: PHONE, knownPickupAddress: "Calle 5 # 38-10", knownPickupLocation: PICKUP, ...over });
}

/** Pide, confirma y devuelve el viaje que quedó (de un restaurante ya registrado). */
async function placeOrder(c: ReturnType<typeof chat>, over: Partial<Fields> = {}, say = "Pedido") {
  const before = (await allTrips()).length;
  await c.say(say, understood([complete(over)]));
  await c.press(order.CONFIRM_BUTTON_ID);
  const trips = await allTrips();
  assert.equal(trips.length, before + 1, "el pedido confirmado crea un viaje");
  return trips[trips.length - 1];
}

// Los escalados se comprueban igual: pausa, motivo, intentos en cero y el borrador.
async function assertEscalated(c: ReturnType<typeof chat>, reason: RegExp | string, draft: "kept" | "cleared") {
  const row = await c.conversation();
  assert.equal(row.botPaused, true, "el bot queda pausado");
  if (typeof reason === "string") assert.equal(row.escalationReason, reason);
  else assert.match(row.escalationReason ?? "", reason);
  assert.equal(row.failedAttempts, 0, "los intentos vuelven a cero");
  if (draft === "kept") assert.ok(row.draft && normalizeDraft(row.draft).entregas.length > 0, "el borrador se conserva para retomar");
  else assert.equal(row.draft, null, "el borrador se limpia");
}

async function assertNotEscalated(c: ReturnType<typeof chat>) {
  const row = await c.conversation();
  assert.equal(row.botPaused, false, "el bot no se pausa");
  assert.equal(row.escalationReason, null);
}

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  outbox.length = 0;
  modelQueue.length = 0;
  modelCalls.length = 0;
  geocodeCalls.length = 0;
  geocodes.clear();
  dispatched.length = 0;
  nameScores = null;
  quoteOverride = null;
  photoAvailable = false;
  clock = OPEN_AT;
  await saveFareRanges([
    { upToKm: 3, price: PRICE_NEAR },
    { upToKm: 8, price: PRICE_FAR },
    { upToKm: null, price: 12_000 },
  ]);
});

// ---------------------------------------------------------------------------

describe("order.ts: máquina de estados del restaurante (Postgres)", { skip: integrationSkip }, () => {
  // Dentro del describe: sin base se salta y no toca `db` (que sin DATABASE_URL lanza).
  after(closeTestDatabase);

  describe("flujos normales de pedido y cotización", () => {
    it("pedido completo: cotiza con botón y, al confirmar, crea el viaje y lo despacha", async () => {
      await registered();
      const c = chat();
      await c.say("Hola, tenemos domi: Marta, 3001234567, Calle 10 # 5-20. En 10", understood([complete()]));
      assert.match(c.reply, /Serían \$ ?5\.000/);
      assert.match(c.reply, /Calle 10 # 5-20/);
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      const quoted = await c.draft();
      assert.equal(quoted?.etapa, "cotizado");
      assert.ok(quoted?.resumenMostrado);
      assert.equal((await allTrips()).length, 0, "cotizar no crea viajes");

      await c.press(order.CONFIRM_BUTTON_ID);
      const [trip] = await allTrips();
      assert.equal(trip.status, "pending");
      assert.equal(trip.deliveryFee, PRICE_NEAR);
      assert.equal(trip.customerName, "Marta Ríos");
      assert.equal(trip.deliveryAddress, "Calle 10 # 5-20");
      assert.deepEqual(dispatched, [trip.id]);
      assert.ok(c.reply.includes(trip.code), "la confirmación nombra el pedido");
      assert.equal(await c.draft(), null, "al crear el viaje el borrador se vacía");
      await assertNotEscalated(c);
    });

    it("la confirmación escrita («sí») también pide la moto", async () => {
      await registered();
      const c = chat();
      await c.say("pedido", understood([complete()]));
      await c.say("sí, confirmo", understood([complete()], { confirms: true }));
      assert.equal((await allTrips()).length, 1);
    });

    it("confirmar con el botón sin nada cotizado no crea nada", async () => {
      await registered();
      const c = chat();
      await c.press(order.CONFIRM_BUTTON_ID);
      assert.match(c.reply, /No tengo un pedido por confirmar/);
      assert.equal((await allTrips()).length, 0);
    });

    it("si el pedido cambia después de mostrarlo, confirmar no vale: se le muestra de nuevo", async () => {
      await registered();
      const c = chat();
      await c.say("pedido", understood([complete()]));
      // Cambia el nombre y, en el mismo mensaje, dice que sí: no vio el resumen nuevo.
      await c.say("a nombre de Pedro, sí", understood([complete({ nombreCliente: "Pedro Gómez" })], { confirms: true }));
      assert.equal((await allTrips()).length, 0);
      assert.match(c.reply, /Pedro Gómez/);
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      await c.press(order.CONFIRM_BUTTON_ID);
      assert.equal((await allTrips()).length, 1);
    });

    it("con datos que faltan: el precio y una pregunta normal con todo lo que falta, sin botón", async () => {
      await registered();
      const c = chat();
      await c.say("a la calle 10 # 5-20", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
      assert.match(c.reply, /Serían \$ ?5\.000/);
      assert.match(c.reply, /¿me pasas el nombre y el teléfono del cliente y en cuánto tiempo está listo\?$/);
      assert.equal(c.replyButtons.length, 0);
      // Los da en el mensaje siguiente: ya sale completo, con botón.
      await c.say("Marta, 3001234567, en 10", understood([complete()]));
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
    });

    it("un conjunto sin torre ni apto: lo pide aunque lo demás esté completo", async () => {
      await registered();
      const c = chat();
      await c.say("pedido", understood([complete({ direccionEntrega: "Conjunto Bosques del Lili, Calle 10 # 5-20", esConjunto: true })]));
      assert.match(c.reply, /¿me pasas la torre y el apartamento\?/);
      assert.equal(c.replyButtons.length, 0);
    });

    it("la dirección se ubica una sola vez aunque lleguen más mensajes", async () => {
      await registered();
      const c = chat();
      await c.say("calle", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
      await c.say("Marta", understood([delivery({ direccionEntrega: "Calle 10 # 5-20", nombreCliente: "Marta Ríos" })]));
      assert.deepEqual(geocodeCalls, ["Calle 10 # 5-20"]);
    });

    it("datos fragmentados en ráfagas: mergeTurns los junta en un solo turno y se responde una vez", async () => {
      await registered();
      const c = chat();
      const base = Date.parse("2026-11-10T20:05:00Z");
      const rows = ["Calle 48 # 98-20", "Marta Ríos", "3001234567", "en 10"].map((text, i) => ({
        id: i + 1,
        waMessageId: `wamid.burst.${i + 1}`,
        createdAt: new Date(base + i * 2_000),
        text,
        incoming: { kind: "text" as const, text },
      }));
      const merged = turns.mergeTurns(rows, { phone: PHONE, profileName: null }, (id) => id.startsWith("pedido:"));
      assert.equal(merged.length, 1);
      assert.equal(merged[0].kind === "text" && merged[0].text, "Calle 48 # 98-20\nMarta Ríos\n3001234567\nen 10");
      // El turno conserva el wamid y la hora del primero: de ahí se cita y se cuenta el tiempo.
      assert.equal(merged[0].waMessageId, "wamid.burst.1");

      modelQueue.push(understood([complete({ direccionEntrega: "Calle 48 # 98-20" })]));
      const { upsertConversationOnInbound } = await import("@/db/queries/conversation");
      const conversation = await upsertConversationOnInbound(PHONE, null);
      const before = outbox.length;
      await order.handleRestaurant({ conversation, message: merged[0], restaurant: await (await import("@dispatch/shared/db")).findRestaurantByPhone(PHONE) });
      assert.equal(outbox.length - before, 1, "un solo mensaje de respuesta para toda la ráfaga");
      assert.equal(modelCalls.length, 1, "el modelo lee el turno una vez");
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      assert.equal((await c.draft())?.mensajeOrigen, "wamid.burst.1");
    });

    it("varias entregas: una cotización con total y un botón; al confirmar, un viaje por entrega", async () => {
      await registered();
      const c = chat();
      await c.say(
        "dos domis",
        understood([complete({ direccionEntrega: "Calle 10 # 5-20", nombreCliente: "Marta" }), complete({ direccionEntrega: "Carrera 8 # 9-10", nombreCliente: "Luis", telefonoCliente: "3109998877" })]),
      );
      assert.match(c.reply, /Serían 2 domicilios/);
      assert.match(c.reply, /Total: \$ ?10\.000/);
      assert.deepEqual(c.replyButtons.map((b) => b.title), ["Confirmar los 2"]);
      await c.press(order.CONFIRM_BUTTON_ID);
      const trips = await allTrips();
      assert.equal(trips.length, 2);
      assert.deepEqual(trips.map((t) => t.customerName).sort(), ["Luis", "Marta"]);
      assert.deepEqual(dispatched.sort(), trips.map((t) => t.id).sort());
    });

    it("quitar una entrega: se le vuelve a mostrar el pedido y solo se crea la que queda", async () => {
      await registered();
      const c = chat();
      const a = complete({ direccionEntrega: "Calle 10 # 5-20", nombreCliente: "Marta" });
      const b = complete({ direccionEntrega: "Carrera 8 # 9-10", nombreCliente: "Luis", telefonoCliente: "3109998877" });
      await c.say("dos domis", understood([a, b]));
      assert.match(c.reply, /Serían 2 domicilios/);
      await c.say("solo es 1", understood([a, b], { quitar: [2] }));
      assert.equal((await c.draft())?.entregas.length, 1);
      assert.match(c.reply, /Serían \$ ?5\.000/);
      assert.ok(!/Luis/.test(c.reply));
      await c.press(order.CONFIRM_BUTTON_ID);
      const trips = await allTrips();
      assert.equal(trips.length, 1);
      assert.equal(trips[0].customerName, "Marta");
    });

    it("quitar todas no se hace: cancelar el pedido entero lo resuelve la central", async () => {
      await registered();
      const c = chat();
      await c.say("un domi", understood([complete()]));
      await c.say("ninguna", understood([complete()], { quitar: [1] }));
      assert.equal((await c.draft())?.entregas.length, 1);
    });

    it("un pin de WhatsApp se ubica sin geocodificar", async () => {
      await registered();
      const c = chat();
      await c.pin(NEAR.lat, NEAR.lng, "Cra 98 # 45-11");
      assert.deepEqual(geocodeCalls, [], "las coordenadas exactas no pagan geocodificación");
      const draft = await c.draft();
      assert.deepEqual(draft?.entregas[0].ubicacionEntrega, NEAR);
      assert.match(c.reply, /Serían \$ ?5\.000/);
    });

    it("restaurante nuevo: da su recogida, confirma y queda registrado con su número", async () => {
      const c = chat();
      await c.say("Calle 5 # 38-10, domi a Calle 10 # 5-20", understood([complete()], { origen: "Calle 5 # 38-10" }), { profileName: "Burgers Don Pepe" });
      assert.deepEqual(geocodeCalls, ["Calle 5 # 38-10", "Calle 10 # 5-20"], "recogida y entrega, una vez cada una");
      await c.press(order.CONFIRM_BUTTON_ID);
      const [created] = await db.select().from(schema.restaurants);
      assert.equal(created.name, "Burgers Don Pepe");
      assert.equal(created.phone, PHONE);
      assert.equal(created.knownPickupAddress, "Calle 5 # 38-10");
      const [trip] = await allTrips();
      assert.equal(trip.restaurantId, created.id);
      assert.ok(outbox.some((m) => /Guardé tu dirección de recogida/.test(m.text)));
    });

    it("un audio o un sticker: se le dice que solo se leen textos y ubicaciones, sin tocar el pedido", async () => {
      await registered();
      const c = chat();
      await c.say("calle", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
      const before = await c.draft();
      await c.raw((head) => ({ ...head, kind: "unsupported", type: "audio" }));
      assert.match(c.reply, /leo mensajes de texto y ubicaciones/);
      assert.deepEqual(await c.draft(), before);
      await assertNotEscalated(c);
    });
  });

  describe("solo cotizar y pasar después a pedido (soloPrecio)", () => {
    it("preguntar el precio responde sin botón ni datos, y no crea viaje", async () => {
      await registered();
      const c = chat();
      await c.say("¿Qué vale el domicilio a la Clínica Farallones?", understood([delivery({ direccionEntrega: "Clínica Farallones" })], { intent: "cotizar" }));
      assert.match(c.reply, /el domicilio vale \$ ?5\.000/);
      assert.equal(c.replyButtons.length, 0);
      assert.equal((await c.draft())?.soloPrecio, true);
      assert.equal((await allTrips()).length, 0);
    });

    it("después pide el servicio con los datos: es el mismo pedido, un solo viaje", async () => {
      await registered();
      const c = chat();
      await c.say("¿cuánto a Farallones?", understood([delivery({ direccionEntrega: "Clínica Farallones" })], { intent: "cotizar" }));
      await c.say("dale, a nombre de Marta, 3001234567, en 10", understood([complete({ direccionEntrega: "Clínica Farallones" })], { intent: "pedir" }));
      assert.equal((await c.draft())?.soloPrecio, false);
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      await c.press(order.CONFIRM_BUTTON_ID);
      assert.equal((await allTrips()).length, 1, "preguntar el precio y luego pedir no duplica el viaje");
    });

    it("otra dirección después de solo cotizar es otra cotización, no un segundo domicilio", async () => {
      await registered();
      const c = chat();
      await c.say("¿cuánto a Farallones?", understood([delivery({ direccionEntrega: "Clínica Farallones" })], { intent: "cotizar" }));
      await c.say("¿y a Pance?", understood([delivery({ direccionEntrega: "Pance" })], { intent: "cotizar" }));
      const draft = await c.draft();
      assert.equal(draft?.entregas.length, 1);
      assert.equal(draft?.entregas[0].direccionEntrega, "Pance");
    });

    it("preguntar si llegan a un barrio (cobertura) también es solo cotizar", async () => {
      await registered();
      const c = chat();
      await c.say("¿llegan a Pance?", understood([delivery({ direccionEntrega: "Pance" })], { query: "cobertura" }));
      assert.equal(c.replyButtons.length, 0);
      assert.equal((await c.draft())?.soloPrecio, true);
    });

    it("tras un «gracias» neutro, el bot se queda callado", async () => {
      await registered();
      const c = chat();
      await c.say("¿cuánto a Farallones?", understood([delivery({ direccionEntrega: "Clínica Farallones" })], { intent: "cotizar" }));
      const before = outbox.length;
      await c.say("gracias", understood([]));
      assert.equal(outbox.length, before);
    });
  });

  describe("cambios a un pedido ya creado (trip-updates.ts)", () => {
    it("«ya está listo» citando el pedido: marca listo, avisa al restaurante y no abre otro viaje", async () => {
      await registered();
      const c = chat();
      const trip = await placeOrder(c);
      await c.say("ya está listo", understood([delivery({ listoEnMinutos: 0 })]), { replyTo: trip.sourceWaMessageId });
      assert.match(c.reply, new RegExp(`Anotado ✅ ${trip.code}: la comida ya está lista`));
      const [after] = await allTrips();
      assert.ok(after.readyAt && after.readyAt.getTime() <= Date.now() + 1_000);
      assert.equal((await allTrips()).length, 1);
    });

    it("«se demora 5 más» sin citar, con un solo pedido abierto: es ese", async () => {
      await registered();
      const c = chat();
      const trip = await placeOrder(c);
      const at = new Date(OPEN_AT + 600_000);
      await c.say("se demora 5 más", understood([delivery({ listoEnMinutos: 5 })]), { at });
      assert.match(c.reply, /la comida está lista en 5 min/);
      const [after] = await allTrips();
      assert.equal(after.id, trip.id);
      assert.equal(after.readyAt?.getTime(), at.getTime() + 5 * 60_000, "el tiempo se cuenta desde el mensaje");
    });

    it("torre y apartamento llegan después: se agregan a la dirección del viaje", async () => {
      await registered();
      const c = chat();
      await placeOrder(c);
      await c.say("es torre 2 apto 301", understood([delivery({ detalleDireccion: "Torre 2 apto 301" })]));
      const [after] = await allTrips();
      assert.equal(after.deliveryAddress, "Calle 10 # 5-20 · Torre 2 apto 301");
      assert.match(c.reply, /la entrega es en Torre 2 apto 301/);
    });

    it("valor a cobrar y método de pago: se guardan y el efectivo marca el regreso de plata", async () => {
      await registered();
      const c = chat();
      await placeOrder(c);
      await c.say("cobra 50 mil en efectivo", understood([delivery({ valorACobrar: 50_000, metodoPago: "efectivo" })]));
      const [after] = await allTrips();
      assert.equal(after.valueToCollect, 50_000);
      assert.equal(after.paymentMethod, "efectivo");
      assert.equal(after.requiresCashReturn, true);
      assert.match(c.reply, /se cobra en efectivo/);
      assert.match(c.reply, /valor a cobrar \$ ?50\.000/);
    });

    it("datáfono: se le dice al domiciliario que pida el datáfono, sin regreso de efectivo", async () => {
      await registered();
      const c = chat();
      await placeOrder(c);
      await c.say("paga con tarjeta", understood([delivery({ metodoPago: "datafono" })]));
      const [after] = await allTrips();
      assert.equal(after.paymentMethod, "datafono");
      assert.equal(after.requiresCashReturn, false);
      assert.match(c.reply, /pide el datáfono/);
    });

    it("una nota nueva se suma a las que ya tenía el viaje", async () => {
      await registered();
      const c = chat();
      await placeOrder(c, { notas: "2 hamburguesas" });
      await c.say("llevar salsas", understood([delivery({ notas: "llevar salsas" })]));
      const [after] = await allTrips();
      assert.equal(after.notes, "2 hamburguesas · llevar salsas");
    });

    it("lo nombra por su código en el texto y no hace falta citar", async () => {
      await registered();
      const c = chat();
      const first = await placeOrder(c, { direccionEntrega: "Calle 10 # 5-20" });
      await placeOrder(c, { direccionEntrega: "Carrera 8 # 9-10", nombreCliente: "Luis" });
      await c.say(`el ${first.code} ya está listo`, understood([delivery({ listoEnMinutos: 0 })]));
      assert.match(c.reply, new RegExp(`Anotado ✅ ${first.code}`));
      const trips = await allTrips();
      assert.ok(trips.find((t) => t.id === first.id)?.readyAt, "cambió el que nombró");
    });

    it("con varios abiertos y sin citar: pregunta con botones, guarda el cambio y lo aplica al que elija", async () => {
      await registered();
      const c = chat();
      const first = await placeOrder(c, { direccionEntrega: "Calle 10 # 5-20" });
      const second = await placeOrder(c, { direccionEntrega: "Carrera 8 # 9-10", nombreCliente: "Luis" });
      await c.say("ya está listo", understood([delivery({ listoEnMinutos: 0 })]));
      assert.match(c.reply, /¿De cuál pedido hablas\?/);
      assert.deepEqual(c.replyButtons.map((b) => b.id).sort(), [`pedido:${first.id}`, `pedido:${second.id}`].sort());
      assert.ok((await c.draft())?.actualizacionPendiente, "el cambio queda esperando");

      const readyBefore = Object.fromEntries((await allTrips()).map((t) => [t.id, t.readyAt?.getTime()]));
      await c.press(`pedido:${second.id}`);
      const trips = await allTrips();
      assert.notEqual(trips.find((t) => t.id === second.id)?.readyAt?.getTime(), readyBefore[second.id], "se aplicó al elegido");
      assert.equal(trips.find((t) => t.id === first.id)?.readyAt?.getTime(), readyBefore[first.id], "y no al otro");
      assert.equal((await c.draft())?.actualizacionPendiente, null, "el cambio pendiente se limpia");
    });

    it("con más de 3 abiertos no hay botones: pide citar el mensaje del pedido", async () => {
      await registered();
      const c = chat();
      for (const n of [1, 2, 3, 4]) await placeOrder(c, { direccionEntrega: `Calle ${n} # 5-20`, nombreCliente: `Cliente ${n}` });
      await c.say("ya está listo", understood([delivery({ listoEnMinutos: 0 })]));
      assert.match(c.reply, /citando el mensaje del pedido/);
      assert.equal(c.replyButtons.length, 0);
    });

    it("citar el pedido gana sobre preguntar, aunque haya varios abiertos", async () => {
      await registered();
      const c = chat();
      const first = await placeOrder(c, { direccionEntrega: "Calle 10 # 5-20" });
      await placeOrder(c, { direccionEntrega: "Carrera 8 # 9-10", nombreCliente: "Luis" });
      await c.say("ya está listo", understood([delivery({ listoEnMinutos: 0 })]), { replyTo: first.sourceWaMessageId });
      assert.match(c.reply, new RegExp(`Anotado ✅ ${first.code}`));
      assert.ok(!/¿De cuál pedido/.test(c.reply));
    });

    it("tocar un botón de pedido sin cambio pendiente: lo dice y no cambia nada", async () => {
      await registered();
      const c = chat();
      const trip = await placeOrder(c);
      await c.press(`pedido:${trip.id}`);
      assert.match(c.reply, /No tengo ningún cambio pendiente/);
      assert.equal((await allTrips())[0].readyAt?.getTime(), trip.readyAt?.getTime());
    });

    it("un botón de un pedido de otra conversación no se aplica", async () => {
      await registered();
      const c = chat();
      await placeOrder(c);
      const stranger = await createTrip({ conversationId: (await createConversation()).id });
      await c.press(`pedido:${stranger.id}`);
      assert.match(c.reply, /No tengo ningún cambio pendiente/);
      assert.equal((await db.select().from(schema.trips).where(eq(schema.trips.id, stranger.id)))[0].readyAt, null);
    });

    it("sobre un pedido ya entregado: se le dice que ya estaba entregado", async () => {
      await registered();
      const c = chat();
      const trip = await placeOrder(c);
      await db.update(schema.trips).set({ status: "delivered" }).where(eq(schema.trips.id, trip.id));
      await c.say("ya está listo", understood([delivery({ listoEnMinutos: 0 })]), { replyTo: trip.sourceWaMessageId });
      assert.match(c.reply, /ya estaba entregado/);
    });

    it("«ya está listo» sin ningún pedido abierto sigue como un pedido nuevo (pide la dirección)", async () => {
      await registered();
      const c = chat();
      await c.say("ya está listo", understood([delivery({ listoEnMinutos: 0 })]));
      assert.equal((await allTrips()).length, 0);
      assert.match(c.reply, /¿A qué dirección|Envíame la dirección/, "no hay a qué pedido aplicarlo: pide la dirección");
    });
  });

  describe("escalados: el bot se aparta y la central retoma", () => {
    describe("identidad", () => {
      it("responde «No» a «¿Hablo con…?»: pasa a la central y conserva el pedido", async () => {
        const restaurant = await registered();
        nameScores = (_n, cands) => new Map(cands.map((x) => [x.id, 0.1]));
        const c = chat();
        await c.say("pedido de Burgers Don Pepe", understood([complete()], { nombreRestaurante: "Burgers Don Pepe" }));
        assert.equal(c.reply, `¿Hablo con ${restaurant.name}?`);
        assert.deepEqual(c.replyButtons.map((b) => b.id), [order.IDENTITY_YES_BUTTON_ID, order.IDENTITY_NO_BUTTON_ID]);
        assert.equal((await c.draft())?.preguntaIdentidad, true);
        await assertNotEscalated(c);

        await c.press(order.IDENTITY_NO_BUTTON_ID);
        await assertEscalated(c, "Escribe desde el número de Pizza Nona, pero dice que no es ese restaurante.", "kept");
        assert.equal(c.reply, ESCALATION_MESSAGE);
        assert.equal((await c.draft())?.preguntaIdentidad, false, "ya no se vuelve a preguntar");
        assert.equal((await allTrips()).length, 0);
      });

      it("el «No» escrito en texto también lo pasa a la central", async () => {
        await registered();
        nameScores = (_n, cands) => new Map(cands.map((x) => [x.id, 0.1]));
        const c = chat();
        await c.say("pedido", understood([complete()], { nombreRestaurante: "Burgers Don Pepe" }));
        await c.say("no, soy otro restaurante", understood([]));
        await assertEscalated(c, /dice que no es ese restaurante/, "kept");
      });

      it("«Sí» sigue con el pedido, sin escalar, y no se repite la pregunta", async () => {
        await registered();
        nameScores = (_n, cands) => new Map(cands.map((x) => [x.id, 0.1]));
        const c = chat();
        await c.say("pedido", understood([complete()], { nombreRestaurante: "Burgers Don Pepe" }));
        await c.press(order.IDENTITY_YES_BUTTON_ID);
        await assertNotEscalated(c);
        assert.equal((await c.draft())?.preguntaIdentidad, false);
        // El modelo vuelve a decir el mismo nombre: el nombre ya se revisó, no se pregunta otra vez.
        await c.say("confirmo", understood([complete()], { nombreRestaurante: "Burgers Don Pepe", confirms: true }));
        assert.equal(outbox.filter((m) => /¿Hablo con/.test(m.text)).length, 1, "la pregunta se hizo una sola vez");
      });

      it("número nuevo con el nombre de un restaurante que ya tiene otro número: escala y conserva el pedido", async () => {
        await createRestaurant({ name: "Pizza Nona", phone: "573009998877", knownPickupAddress: "Calle 5 # 38-10", knownPickupLocation: PICKUP });
        const c = chat();
        await c.say("pedido de Pizza Nona", understood([complete()], { nombreRestaurante: "Pizza Nona" }));
        await assertEscalated(c, "Escribe desde un número nuevo con el nombre de Pizza Nona, que tiene otro número registrado.", "kept");
        assert.equal(c.reply, ESCALATION_MESSAGE);
      });

      it("número nuevo con el nombre de un restaurante sin número: se vincula y sigue el pedido", async () => {
        const restaurant = await createRestaurant({ name: "Pizza Nona", phone: null, knownPickupAddress: "Calle 5 # 38-10", knownPickupLocation: PICKUP });
        const c = chat();
        await c.say("pedido de Pizza Nona", understood([complete()], { nombreRestaurante: "Pizza Nona" }));
        await assertNotEscalated(c);
        const [linked] = await db.select().from(schema.restaurants).where(eq(schema.restaurants.id, restaurant.id));
        assert.equal(linked.phone, PHONE);
        assert.ok(outbox.some((m) => /Te reconocí como Pizza Nona/.test(m.text)));
        assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID], "y sigue con la cotización");
      });

      it("colisión al vincular el número (ya es de otro restaurante): escala y conserva el pedido", async () => {
        // Un restaurante inactivo ya tiene este número: no se ve al buscar por número, pero impide vincularlo.
        await createRestaurant({ name: "Cerrado Antiguo", phone: PHONE, active: false });
        await createRestaurant({ name: "Pizza Nona", phone: null, knownPickupAddress: "Calle 5 # 38-10", knownPickupLocation: PICKUP });
        const c = chat();
        await c.say("pedido de Pizza Nona", understood([complete()], { nombreRestaurante: "Pizza Nona" }));
        await assertEscalated(c, "Parece ser Pizza Nona, pero no se le pudo guardar este número: ya es de otro restaurante.", "kept");
        assert.equal(c.reply, ESCALATION_MESSAGE);
      });

      it("con el modelo de nombres caído no se escala: se trata como restaurante nuevo", async () => {
        await createRestaurant({ name: "Pizza Nona", phone: "573009998877" });
        nameScores = () => null;
        const c = chat();
        await c.say("pedido", understood([complete()], { origen: "Calle 5 # 38-10", nombreRestaurante: "Pizzería La Nona Vieja" }));
        await assertNotEscalated(c);
      });
    });

    describe("reintentos fallidos (MAX_CLARIFICATION_ATTEMPTS)", () => {
      it("el tope es de 2 mensajes", () => {
        assert.equal(MAX_CLARIFICATION_ATTEMPTS, 2);
      });

      it("2 mensajes seguidos sin dirección de entrega: escala y limpia el borrador", async () => {
        await registered();
        const c = chat();
        // Da el nombre pero no la dirección: avanza (no suma intento).
        await c.say("para Marta", understood([delivery({ nombreCliente: "Marta Ríos" })]));
        assert.match(c.reply, /¿A qué dirección es la entrega\?/);
        // Primer mensaje que no aporta: un intento, el bot sigue preguntando.
        await c.say("mmm", understood([delivery({ nombreCliente: "Marta Ríos" })]));
        assert.equal((await c.conversation()).failedAttempts, 1);
        await assertNotEscalated(c);
        // Segundo: se acabaron los intentos.
        await c.say("mmm??", understood([delivery({ nombreCliente: "Marta Ríos" })]));
        await assertEscalated(c, "2 mensajes seguidos sin dirección de entrega.", "cleared");
        assert.equal(c.reply, ESCALATION_MESSAGE);
      });

      it("un mensaje que sí aporta algo reinicia los intentos", async () => {
        await registered();
        const c = chat();
        await c.say("para Marta", understood([delivery({ nombreCliente: "Marta Ríos" })]));
        await c.say("mmm", understood([delivery({ nombreCliente: "Marta Ríos" })]));
        assert.equal((await c.conversation()).failedAttempts, 1);
        await c.say("su teléfono es 3001234567", understood([delivery({ nombreCliente: "Marta Ríos", telefonoCliente: "3001234567" })]));
        assert.equal((await c.conversation()).failedAttempts, 0);
        await assertNotEscalated(c);
      });

      it("el primer mensaje sin datos pide la dirección: no cuenta como intento", async () => {
        await registered();
        const c = chat();
        await c.say("necesito un domi", understood([], { intent: "pedir" }));
        // Ya lleva el saludo del día encima: no se repite el «¡Hola!».
        assert.equal(c.reply, "Envíame la dirección de entrega y te cotizo 🛵");
        assert.equal((await c.conversation()).failedAttempts, 0);
      });

      it("2 mensajes seguidos sin una recogida que se pueda ubicar: escala y limpia el borrador", async () => {
        const c = chat();
        geocodes.set("Cerca del parque", { kind: "not_found" });
        // El primer mensaje trae datos nuevos (avanza), así que no suma intento.
        const first = await c.say("Cerca del parque; domi a Calle 10 # 5-20", understood([complete()], { origen: "Cerca del parque" }));
        assert.match(plain(first.sent[0].text), /No encuentro «Cerca del parque» en el mapa/);
        assert.equal((await c.conversation()).failedAttempts, 0);
        // Desde aquí no aporta nada nuevo: un intento, y el bot vuelve a pedir la recogida.
        await c.say("por el parque", understood([complete()], { origen: "Cerca del parque" }));
        assert.equal((await c.conversation()).failedAttempts, 1);
        assert.match(c.reply, /No encuentro «Cerca del parque»/);
        await assertNotEscalated(c);
        await c.say("el parque", understood([complete()], { origen: "Cerca del parque" }));
        await assertEscalated(c, "2 mensajes seguidos sin dirección de recogida que se pueda ubicar.", "cleared");
        assert.equal(c.reply, ESCALATION_MESSAGE);
      });

      it("la recogida sin dato alguno se pide con el número completo y el barrio", async () => {
        const c = chat();
        await c.say("domi a Calle 10 # 5-20", understood([complete()]));
        assert.match(c.reply, /¿Desde qué dirección se recoge\?/);
      });

      it("2 mensajes seguidos sin los datos que faltan: escala y limpia el borrador", async () => {
        await registered();
        const c = chat();
        await c.say("calle", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
        assert.match(c.reply, /el nombre y el teléfono del cliente/);
        // Escribe sin dar nada: un intento. Con el precio ya mostrado, un «ok» sería silencio; esto no.
        await c.say("y?", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
        assert.equal((await c.conversation()).failedAttempts, 1);
        await c.say("y?", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
        await assertEscalated(c, "2 mensajes seguidos sin los datos que faltan.", "cleared");
        assert.equal(c.reply, ESCALATION_MESSAGE);
      });

      it("2 mensajes seguidos sin confirmar el servicio: escala y limpia el borrador", async () => {
        await registered();
        const c = chat();
        await c.say("pedido", understood([complete()]));
        assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
        await c.say("y?", understood([complete()]));
        assert.equal((await c.conversation()).failedAttempts, 1);
        await c.say("y?", understood([complete()]));
        await assertEscalated(c, "2 mensajes seguidos sin confirmar el servicio.", "cleared");
        assert.equal((await allTrips()).length, 0);
      });
    });

    describe("consulta a un asesor (askAdvisor)", () => {
      it("el mapa no ubica la dirección (not_found): pregunta a la central y conserva el pedido", async () => {
        await registered();
        geocodes.set("Carrera 83B #14A-121, El Ingenio", { kind: "not_found" });
        const c = chat();
        await c.say("domi a la Carrera 83B", understood([complete({ direccionEntrega: "Carrera 83B #14A-121, El Ingenio" })]));
        await assertEscalated(c, /^Consulta de dirección: no la encuentro en el mapa\. ¿Es válida «Carrera 83B #14A-121, El Ingenio» y cuánto vale el domicilio\?$/, "kept");
        assert.ok((await c.conversation()).escalationReason?.startsWith(order.ADVISOR_QUERY_REASON));
        assert.match(c.reply, /No logro ubicar «Carrera 83B #14A-121, El Ingenio» en el mapa/);
        const draft = await c.draft();
        assert.deepEqual(draft?.consultaAsesor?.entregas, [0]);
        assert.equal(draft?.entregas[0].nombreCliente, "Marta Ríos", "no se pierden los demás datos");
        assert.equal(draft?.entregas[0].ubicacionEntrega, null);
      });

      it("Google caído (down): lo mismo, con el motivo «el mapa no respondió»", async () => {
        await registered();
        geocodes.set("Calle 10 # 5-20", { kind: "failed" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        await assertEscalated(c, /^Consulta de dirección: el mapa no respondió\./, "kept");
        assert.match(c.reply, /No puedo ubicar direcciones en este momento/);
      });

      it("Google sin llave (disabled) se trata como caído", async () => {
        await registered();
        geocodes.set("Calle 10 # 5-20", { kind: "disabled" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        await assertEscalated(c, /el mapa no respondió/, "kept");
      });

      it("con varias entregas, pregunta solo por las que el mapa no ubicó", async () => {
        await registered();
        geocodes.set("Calle sin nombre", { kind: "not_found" });
        const c = chat();
        await c.say("dos", understood([complete({ direccionEntrega: "Calle 10 # 5-20" }), complete({ direccionEntrega: "Calle sin nombre", nombreCliente: "Luis" })]));
        await assertEscalated(c, /«Calle sin nombre»/, "kept");
        assert.deepEqual((await c.draft())?.consultaAsesor?.entregas, [1]);
        assert.ok(!/«Calle 10 # 5-20»/.test((await c.conversation()).escalationReason ?? ""));
      });

      it("no se puede medir por calle (no_route): pregunta a la central", async () => {
        await registered();
        quoteOverride = async () => ({ km: 0, source: "calle", routable: false, coverage: "ok", price: null, breakdown: null });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        await assertEscalated(c, /^Consulta de dirección: no puedo medirla por calle\./, "kept");
        assert.match(c.reply, /No puedo medir el domicilio a «Calle 10 # 5-20» por calle/);
      });

      it("mientras el asesor no responde, el bot no contesta en ese chat", async () => {
        await registered();
        geocodes.set("Calle 10 # 5-20", { kind: "not_found" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        const before = outbox.length;
        const again = await c.raw((head) => ({ ...head, kind: "text", text: "¿ya?" }));
        assert.equal(again.silent, true);
        assert.equal(outbox.length, before);
      });

      it("el asesor confirma la dirección y el precio: se retoma con el draft y se puede confirmar (advisor.ts)", async () => {
        await registered();
        geocodes.set("Calle 10 # 5-20", { kind: "not_found" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        const row = await c.conversation();

        const result = await advisor.answerAdvisorQuery(row.id, [{ indice: 0, valida: true, precio: 8_000, direccion: "Calle 10 # 5-20, Ciudad Jardín" }]);
        assert.deepEqual(result, { ok: true });
        await assertNotEscalated(c);
        const resumed = await c.draft();
        assert.equal(resumed?.consultaAsesor, null);
        assert.equal(resumed?.entregas[0].cotizacion?.precio, 8_000);
        assert.equal(resumed?.entregas[0].validadaPorAsesor, true);
        assert.equal(resumed?.entregas[0].nombreCliente, "Marta Ríos", "conserva lo que ya había dado");
        assert.match(c.reply, /La central confirmó la dirección ✅/);
        assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);

        await c.press(order.CONFIRM_BUTTON_ID);
        const [trip] = await allTrips();
        assert.equal(trip.deliveryFee, 8_000, "se cobra el precio del asesor");
      });

      it("el asesor dice que la dirección no es válida: se le pide corregirla y el bot vuelve a atender", async () => {
        await registered();
        geocodes.set("Calle 10 # 5-20", { kind: "not_found" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        const row = await c.conversation();
        await advisor.answerAdvisorQuery(row.id, [{ indice: 0, valida: false }]);
        await assertNotEscalated(c);
        assert.match(c.reply, /La central no encuentra «Calle 10 # 5-20»/);
        assert.equal((await c.draft())?.entregas[0].cotizacion, null);
        assert.equal((await c.draft())?.consultaAsesor, null);
      });
    });

    describe("borde de zona (askCoverage)", () => {
      // Un cuadrado de ~2,2 km alrededor de la recogida; el borde norte está en 3.47.
      const ring = [
        { lat: 3.43, lng: -76.55 },
        { lat: 3.43, lng: -76.51 },
        { lat: 3.47, lng: -76.51 },
        { lat: 3.47, lng: -76.55 },
      ];
      /** 100 m al norte del borde: fuera, pero a menos de 300 m. */
      const EDGE = { lat: 3.4709, lng: -76.53 };
      /** Lejos de toda zona. */
      const OUTSIDE = { lat: 3.6, lng: -76.53 };

      it("cerca del borde: pregunta a la central, conserva el pedido y guarda lo que costaría", async () => {
        await registered();
        await createServiceZone({ name: "Ciudad Jardín", ring, barrioCode: null, fareAdjustment: 0 });
        geocodes.set("Calle 10 # 5-20", { kind: "found", location: EDGE, neighborhood: "El Límite" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        await assertEscalated(c, /^Consulta de cobertura: «Calle 10 # 5-20» \(a \d+ m de «Ciudad Jardín»\) queda fuera de las zonas de servicio, cerca del borde\. ¿Se hace\?$/, "kept");
        assert.match(c.reply, /Déjame confirmar con la central si llegamos hasta El Límite/);
        const draft = await c.draft();
        assert.equal(draft?.consultaAsesor?.motivo, "cobertura");
        assert.deepEqual(draft?.consultaAsesor?.entregas, [0]);
        assert.equal(draft?.consultaAsesor?.cobertura?.[0].zona, "Ciudad Jardín");
        assert.ok((draft?.consultaAsesor?.cobertura?.[0].metros ?? 999) <= 300);
        assert.ok((draft?.consultaAsesor?.cobertura?.[0].precio ?? 0) > 0);
        assert.equal(draft?.entregas[0].cotizacion, null, "no se cotiza hasta que la central decida");
      });

      it("la central dice que sí (advisor.ts): se retoma con el precio de la tabla y se puede confirmar", async () => {
        await registered();
        await createServiceZone({ name: "Ciudad Jardín", ring, barrioCode: null, fareAdjustment: 0 });
        geocodes.set("Calle 10 # 5-20", { kind: "found", location: EDGE, neighborhood: "El Límite" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        const proposed = (await c.draft())!.consultaAsesor!.cobertura![0].precio;
        await advisor.answerAdvisorQuery((await c.conversation()).id, [{ indice: 0, valida: true, precio: proposed }]);
        await assertNotEscalated(c);
        assert.match(c.reply, /Confirmé con la central: sí llegamos ✅/);
        assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
        await c.press(order.CONFIRM_BUTTON_ID);
        assert.equal((await allTrips())[0].deliveryFee, proposed);
      });

      it("la central dice que no: el restaurante recibe el «no hay domicilio», el pedido se descarta y el bot vuelve a atender", async () => {
        await registered();
        await createServiceZone({ name: "Ciudad Jardín", ring, barrioCode: null, fareAdjustment: 0 });
        geocodes.set("Calle 10 # 5-20", { kind: "found", location: EDGE, neighborhood: "El Límite" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        await advisor.answerAdvisorQuery((await c.conversation()).id, [{ indice: 0, valida: false }]);
        await assertNotEscalated(c);
        assert.match(c.reply, /no manejamos domicilio/);
        assert.equal(await c.draft(), null);
        assert.equal((await allTrips()).length, 0);
      });

      it("fuera y lejos NO es una consulta: no hay servicio, sin escalar", async () => {
        await registered();
        await createServiceZone({ name: "Ciudad Jardín", ring, barrioCode: null, fareAdjustment: 0 });
        geocodes.set("Calle 10 # 5-20", { kind: "found", location: OUTSIDE, neighborhood: "Lejos" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        await assertNotEscalated(c);
        assert.match(c.reply, /hasta Lejos no manejamos domicilio/);
        assert.equal(await c.draft(), null, "no queda nada por pedir");
        assert.equal((await c.conversation()).draft, null);
        assert.equal((await allTrips()).length, 0);
      });
    });

    describe("falla de ubicación de la recogida (escalateLocationDown)", () => {
      it("Google no responde al ubicar la recogida: pasa a la central con el borrador", async () => {
        const c = chat();
        geocodes.set("Calle 5 # 38-10", { kind: "failed" });
        await c.say("Calle 5 # 38-10; domi a Calle 10 # 5-20", understood([complete()], { origen: "Calle 5 # 38-10" }));
        await assertEscalated(c, "No se pudo ubicar la dirección: Google no respondió o no está configurado.", "kept");
        assert.match(c.reply, /Ya le paso tu pedido a la central/);
      });
    });

    describe("cambio de dirección de un pedido ya creado", () => {
      it("citando el pedido con otra dirección: escala (la central lo resuelve) y limpia el borrador", async () => {
        await registered();
        const c = chat();
        const trip = await placeOrder(c);
        await c.say("mejor a la Carrera 8 # 9-10", understood([delivery({ direccionEntrega: "Carrera 8 # 9-10" })]), { replyTo: trip.sourceWaMessageId });
        await assertEscalated(c, `Pidió cambiar la dirección del pedido ${trip.code}, que ya estaba creado.`, "cleared");
        assert.equal(c.reply, ESCALATION_MESSAGE);
        assert.equal((await allTrips())[0].deliveryAddress, "Calle 10 # 5-20", "el viaje no se toca");
      });
    });

    describe("cancelar un pedido ya creado", () => {
      const cancel = { byModel: true, byText: true };

      it("«me lo cancelas?» con un pedido abierto: no saluda como si fuera nuevo, pasa a la central con el pedido y le confirma", async () => {
        await registered();
        const c = chat();
        const trip = await placeOrder(c);
        await c.say("ahn no se demora mucho me lo cancelas ?", understood([], { cancel }));
        await assertEscalated(c, `Pidió cancelar el pedido ${trip.code}.`, "cleared");
        assert.match(c.reply, new RegExp(`Recibido 🙏 Le paso a la central que quieres cancelar el ${trip.code}`));
        assert.equal((await allTrips())[0].status, trip.status, "el viaje no se toca: lo cancela la central");
      });

      it("nombrándolo por su código, aunque tenga otro abierto", async () => {
        await registered();
        const c = chat();
        const first = await placeOrder(c);
        await placeOrder(c, { direccionEntrega: "Carrera 8 # 9-10" });
        await c.say(`cancelame el ${first.code}`, understood([], { cancel: { byModel: false, byText: true } }));
        await assertEscalated(c, `Pidió cancelar el pedido ${first.code}.`, "cleared");
      });

      it("con varios abiertos y sin decir cuál: la central los ve todos en el motivo", async () => {
        await registered();
        const c = chat();
        const a = await placeOrder(c);
        const b = await placeOrder(c, { direccionEntrega: "Carrera 8 # 9-10" });
        await c.say("cancela el pedido", understood([], { cancel }));
        await assertEscalated(c, `Pidió cancelar un pedido sin decir cuál: tiene abiertos ${b.code} y ${a.code}.`, "cleared");
        assert.match(c.reply, /quieres cancelar tu pedido/);
      });

      it("sin pedidos abiertos: se lo dice, no escala", async () => {
        await registered();
        const c = chat();
        await c.say("cancela el pedido", understood([], { cancel }));
        assert.equal(c.reply, "No tienes pedidos en curso para cancelar 🤔");
        await assertNotEscalated(c);
      });

      it("citando un pedido ya entregado: se lo dice, no escala", async () => {
        await registered();
        const c = chat();
        const trip = await placeOrder(c);
        await db.update(schema.trips).set({ status: "delivered" }).where(eq(schema.trips.id, trip.id));
        await c.say("cancélalo", understood([], { cancel }), { replyTo: trip.sourceWaMessageId });
        assert.equal(c.reply, `El pedido ${trip.code} ya estaba entregado ✅`);
        await assertNotEscalated(c);
      });

      it("con un pedido a medio armar y sin nombrar uno creado, sigue armando (no escala)", async () => {
        await registered();
        const c = chat();
        await c.say("pedido", understood([complete(), complete({ direccionEntrega: "Carrera 8 # 9-10" })]));
        await c.say("cancela la 2", understood([complete(), complete({ direccionEntrega: "Carrera 8 # 9-10" })], { quitar: [2], cancel }));
        await assertNotEscalated(c);
      });
    });

    describe("confuso, pide una persona y tarifas", () => {
      it("datos confusos o pide hablar con una persona: escala y limpia el borrador", async () => {
        await registered();
        const c = chat();
        await c.say("calle", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
        assert.ok(await c.draft());
        await c.say("quiero hablar con alguien", understood([], { confused: true }));
        await assertEscalated(c, "El restaurante dio datos confusos o pidió hablar con una persona.", "cleared");
        assert.equal(c.reply, ESCALATION_MESSAGE);
      });

      it("confuso con un pedido abierto, aun fuera de horario: sí escala (lo ya confirmado se atiende)", async () => {
        await registered();
        const c = chat();
        await placeOrder(c);
        await c.say("el domi no ha llegado", understood([], { confused: true }), { at: new Date(CLOSED_AT) });
        await assertEscalated(c, /datos confusos o pidió hablar con una persona/, "cleared");
      });

      it("encargo (le compran o le traen algo): no cotiza, escala con su motivo y le confirma al restaurante", async () => {
        await registered();
        const c = chat();
        await c.say("Necesito un domi", understood([delivery({})], { intent: "pedir" }));
        await c.say(
          "necesito que me compren un queso tajado en la salsamentaria ciudadela",
          understood([delivery({ direccionEntrega: "Salsamentaria Ciudadela" })], { intent: "pedir", errand: { byModel: true, byText: true } }),
        );
        await assertEscalated(c, "Encargo: «necesito que me compren un queso tajado en la salsamentaria ciudadela»", "cleared");
        assert.equal(c.reply, ERRAND_RECEIVED_MESSAGE);
        assert.equal((await allTrips()).length, 0, "no crea ningún viaje");
        assert.ok(!outbox.some((m) => /\$/.test(m.text ?? "")), "no le cotizó la tienda como si fuera una entrega");
      });

      it("encargo visto solo por la red de seguridad en código: igual escala", async () => {
        await registered();
        const c = chat();
        await c.say("Me traes 30 envases k1 porfis", understood([], { errand: { byModel: false, byText: true } }));
        await assertEscalated(c, /^Encargo: «Me traes 30 envases k1 porfis»$/, "cleared");
      });

      it("tabla de tarifas vacía: no hay con qué cotizar, escala y avisa dónde llenarla", async () => {
        await registered();
        await db.delete(schema.settings);
        const c = chat();
        await c.say("pedido", understood([complete()]));
        await assertEscalated(c, "La tabla de tarifas por km está vacía: no hay con qué cotizar. Llénala en el portal (Tarifas).", "cleared");
        assert.equal(c.reply, ESCALATION_MESSAGE);
        assert.equal((await allTrips()).length, 0);
      });
    });
  });

  describe("lo que NO debe escalar", () => {
    describe("fuera de horario", () => {
      it("sin pedidos abiertos: se avisa una vez, se descarta lo armado y el chat no pasa a la central", async () => {
        await registered();
        const c = chat();
        await c.say("calle", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
        assert.ok(await c.draft());
        await c.say("pedido", understood([complete()]), { at: new Date(CLOSED_AT) });
        assert.match(c.reply, /A esta hora ya no recibimos servicios para tu restaurante/);
        assert.match(c.reply, /Te esperamos mañana desde las 10:00 a\. m\./, "de madrugada se espera para el día siguiente");
        await assertNotEscalated(c);
        const row = await c.conversation();
        assert.equal(row.draft, null, "se descarta lo que estaba a medio armar");
        assert.equal(row.failedAttempts, 0);
        assert.ok(row.closedNoticeAt, "queda registrado que ya se avisó");
        assert.equal((await allTrips()).length, 0);
      });

      it("antes de abrir, por la mañana, el aviso dice «hoy»", async () => {
        await registered();
        const c = chat();
        await c.say("pedido", understood([complete()]), { at: new Date(MORNING_AT) });
        assert.match(c.reply, /Te esperamos hoy desde las 10:00 a\. m\./);
        await assertNotEscalated(c);
      });

      it("si sigue escribiendo esa misma noche, el aviso no se repite", async () => {
        await registered();
        const c = chat();
        await c.say("pedido", understood([complete()]), { at: new Date(CLOSED_AT) });
        const before = outbox.length;
        await c.say("¿hola?", understood([complete()]), { at: new Date(CLOSED_AT + 60_000) });
        assert.equal(outbox.length, before);
        await assertNotEscalated(c);
      });

      it("confirmar con el botón pasada la hora límite: aviso de fuera de horario, sin crear viaje", async () => {
        await registered();
        const c = chat();
        await c.say("pedido", understood([complete()]));
        await c.press(order.CONFIRM_BUTTON_ID, { at: new Date(CLOSED_AT) });
        assert.match(c.reply, /ya no recibimos servicios/);
        assert.equal((await allTrips()).length, 0);
        await assertNotEscalated(c);
      });

      it("un encargo sin pedidos abiertos: es fuera de horario, no escala", async () => {
        await registered();
        const c = chat();
        await c.say("me compran 2 bolsas de hielo en el D1", understood([], { errand: { byModel: true, byText: true } }), { at: new Date(CLOSED_AT) });
        assert.match(c.reply, /A esta hora ya no recibimos servicios para tu restaurante/);
        await assertNotEscalated(c);
      });

      it("datos confusos sin pedidos abiertos: es fuera de horario, no escala", async () => {
        await registered();
        const c = chat();
        await c.say("¿?", understood([], { confused: true }), { at: new Date(CLOSED_AT) });
        assert.match(c.reply, /ya no recibimos servicios/);
        await assertNotEscalated(c);
      });

      it("responder «No» a la pregunta de identidad fuera de horario no pasa a la central", async () => {
        await registered();
        nameScores = (_n, cands) => new Map(cands.map((x) => [x.id, 0.1]));
        const c = chat();
        await c.say("pedido", understood([complete()], { nombreRestaurante: "Burgers Don Pepe" }));
        await c.press(order.IDENTITY_NO_BUTTON_ID, { at: new Date(CLOSED_AT) });
        assert.match(c.reply, /ya no recibimos servicios/);
        await assertNotEscalated(c);
      });

      it("preguntar el estado de un pedido abierto se atiende aunque ya hayan cerrado", async () => {
        await registered();
        const c = chat();
        await placeOrder(c);
        const before = outbox.length;
        await c.say("¿ya llegó el domi?", understood([], { query: "estado" }), { at: new Date(CLOSED_AT) });
        assert.ok(outbox.length > before);
        assert.ok(!/ya no recibimos servicios/.test(c.reply));
        await assertNotEscalated(c);
      });

      it("la hora límite propia del restaurante manda sobre la de la agencia", async () => {
        await createRestaurant({ name: "Pizza Nona", phone: PHONE, knownPickupAddress: "Calle 5 # 38-10", knownPickupLocation: PICKUP, orderDeadline: "14:00" });
        const c = chat();
        // 3 p. m.: abierto para la agencia (hasta 23:30), cerrado para este restaurante (14:00).
        await c.say("pedido", understood([complete()]));
        assert.match(c.reply, /ya no recibimos servicios/);
      });
    });

    describe("fuera de zona (coverage.kind === «fuera»)", () => {
      const ring = [
        { lat: 3.43, lng: -76.55 },
        { lat: 3.43, lng: -76.51 },
        { lat: 3.47, lng: -76.51 },
        { lat: 3.47, lng: -76.55 },
      ];

      it("una entrega fuera y lejos: no se cotiza ni se escala, solo se le dice que no hay servicio", async () => {
        await registered();
        await createServiceZone({ name: "Ciudad Jardín", ring, barrioCode: null, fareAdjustment: 0 });
        geocodes.set("Calle 10 # 5-20", { kind: "found", location: { lat: 3.6, lng: -76.53 }, neighborhood: "Lejos" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        assert.match(c.reply, /Qué pena, pero hasta Lejos no manejamos domicilio 🙏/);
        await assertNotEscalated(c);
        assert.equal((await c.conversation()).draft, null);
        assert.equal((await allTrips()).length, 0);
      });

      it("dos entregas, una fuera: la otra sigue y se cotiza con el aviso", async () => {
        await registered();
        await createServiceZone({ name: "Ciudad Jardín", ring, barrioCode: null, fareAdjustment: 0 });
        geocodes.set("Calle lejos", { kind: "found", location: { lat: 3.6, lng: -76.53 }, neighborhood: "Lejos" });
        const c = chat();
        await c.say("dos", understood([complete({ direccionEntrega: "Calle 10 # 5-20" }), complete({ direccionEntrega: "Calle lejos", nombreCliente: "Luis" })]));
        await assertNotEscalated(c);
        assert.match(c.reply, /hasta Lejos no manejamos domicilio/);
        assert.match(c.reply, /Serían \$ ?5\.000/);
        assert.equal((await c.draft())?.entregas.length, 1);
        await c.press(order.CONFIRM_BUTTON_ID);
        assert.equal((await allTrips()).length, 1);
      });

      it("sin zonas marcadas no se restringe nada", async () => {
        await registered();
        geocodes.set("Calle 10 # 5-20", { kind: "found", location: { lat: 3.6, lng: -76.53 }, neighborhood: "Lejos" });
        const c = chat();
        await c.say("pedido", understood([complete()]));
        assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      });
    });

    describe("falla técnica de OpenAI del lado del restaurante", () => {
      it("responde el mensaje técnico, conserva el borrador y no suma intentos", async () => {
        await registered();
        const c = chat();
        await c.say("calle", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
        await c.say("y?", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
        const attempts = (await c.conversation()).failedAttempts;
        assert.equal(attempts, 1);
        const draftBefore = await c.conversation().then((r) => r.draft);

        await c.say("Marta, 3001234567", understood([], { failed: true }));
        assert.match(c.reply, /Tuve un problema técnico leyendo tu mensaje/);
        assert.match(c.reply, /No se perdió nada de lo que ya me diste/);
        const row = await c.conversation();
        assert.deepEqual(row.draft, draftBefore, "el borrador queda exactamente como estaba");
        assert.equal(row.failedAttempts, attempts, "no suma un intento");
        await assertNotEscalated(c);
      });

      it("aunque falle varias veces seguidas, nunca escala", async () => {
        await registered();
        const c = chat();
        for (let i = 0; i < MAX_CLARIFICATION_ATTEMPTS + 2; i++) await c.say("pedido", understood([], { failed: true }));
        await assertNotEscalated(c);
        assert.equal((await c.conversation()).failedAttempts, 0);
        assert.equal(outbox.filter((m) => /problema técnico/.test(m.text)).length, MAX_CLARIFICATION_ATTEMPTS + 2);
      });

      it("pasada la falla, el pedido sigue donde iba", async () => {
        await registered();
        const c = chat();
        await c.say("calle", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
        await c.say("datos", understood([], { failed: true }));
        await c.say("Marta, 3001234567, en 10", understood([complete()]));
        assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // docs/CONVERSACIONES-REALES.md: cada conversación, un caso
  // -------------------------------------------------------------------------
  describe("casos del simulacro: cobertura, correcciones, datos que faltan y tickets", () => {
    it("«¿llegan a Jamundí?»: sí llegamos y pide la dirección, sin preguntarle a la central ni ubicar nada", async () => {
      await registered();
      const c = chat();
      await c.say("necesito un domi para jamundi llegan ?", understood([delivery({ direccionEntrega: "Jamundí" })], { query: "cobertura", intent: "pedir" }));
      assert.match(c.reply, /^¡Sí! Llegamos a Jamundí 🙌 El precio depende de la dirección: ¿me la envías\?/);
      assert.deepEqual(geocodeCalls, []);
      await assertNotEscalated(c);
      assert.equal((await c.draft())?.entregas.length, 0, "Jamundí no queda como una entrega");

      // Con la dirección, cotiza esa sola: no «2 domicilios».
      await c.say("Calle 10 # 5-20 Lista en 10", understood([delivery({ direccionEntrega: "Calle 10 # 5-20", listoEnMinutos: 10 })], { intent: "pedir" }));
      assert.match(c.reply, /^Serían \$ ?5\.000 hasta Ciudad Jardín/);
      assert.equal((await c.draft())?.entregas.length, 1);
    });

    it("a otro municipio no llegamos: lo dice y no le pregunta a la central", async () => {
      await registered();
      const c = chat();
      await c.say("cuanto a palmira?", understood([delivery({ direccionEntrega: "Palmira" })], { intent: "cotizar" }));
      assert.equal(c.reply, "Qué pena 🙏 A Palmira no llegamos: manejamos Cali y Jamundí.");
      assert.deepEqual(geocodeCalls, []);
      await assertNotEscalated(c);
    });

    it("«nono solo necesito el de la comuna 16, nombre Ramiro»: aunque el modelo lo lea como otra entrega, queda una sola con el nombre", async () => {
      await registered();
      geocodes.set("Calle 40 # 80-10, Los Cerezos", { kind: "found", location: NEAR, neighborhood: "Comuna 16" });
      const c = chat();
      const first = delivery({ direccionEntrega: "Calle 10 # 5-20" });
      const second = delivery({ direccionEntrega: "Calle 40 # 80-10, Los Cerezos", telefonoCliente: "3001234567", listoEnMinutos: 10 });
      await c.say("a la calle 10 # 5-20", understood([first]));
      await c.say("y otro a la Calle 40 # 80-10, Los Cerezos, 3001234567 en 10", understood([first, second]));
      assert.match(c.reply, /Serían 2 domicilios/);
      assert.match(c.reply, /• Calle 40 # 80-10:/, "una comuna no sirve para nombrar la entrega");
      // El modelo se equivoca: arma una tercera entrega con «Comuna 16».
      await c.say("nono solo necesito el de la comuna 16, vale.. nombre del cliente Ramiro", understood([first, second, delivery({ direccionEntrega: "Comuna 16", nombreCliente: "Ramiro" })]));
      const draft = await c.draft();
      assert.equal(draft?.entregas.length, 1);
      assert.equal(draft?.entregas[0].direccionEntrega, "Calle 40 # 80-10, Los Cerezos");
      assert.equal(draft?.entregas[0].nombreCliente, "Ramiro");
      assert.ok(!geocodeCalls.includes("Comuna 16"), "no busca «Comuna 16» en el mapa");
      await assertNotEscalated(c);
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID], "con eso ya está completo");
    });

    it("«ahí están los datos» sin traer lo que falta: le dice qué no encontró, en vez de repetir lo mismo", async () => {
      await registered();
      const c = chat();
      await c.say("a la calle 10 # 5-20, Marta 3001234567", understood([complete({ listoEnMinutos: null })]));
      assert.match(c.reply, /¿En cuánto tiempo está listo el pedido\?$/);
      await c.say("Ahi estan los datos", understood([complete({ listoEnMinutos: null })]));
      assert.equal(c.reply, "No encuentro en cuánto tiempo está listo en lo que me enviaste 🙏 ¿Me lo dices?");
    });

    it("de una foto: primero lo que leyó y después lo que falta", async () => {
      await registered();
      const c = chat();
      await c.photo("", understood([complete({ listoEnMinutos: null })]));
      assert.match(c.reply, /^Esto leí en la imagen 👇 📍 Calle 10 # 5-20 👤 Marta Ríos · 📞 300 123 4567 Serían \$ ?5\.000 hasta Ciudad Jardín 🛵 ¿En cuánto tiempo está listo el pedido\?$/);
    });

    it("el texto junto a la foto («Las Palmas») no le hace preguntar a un restaurante conocido quién es", async () => {
      await registered();
      nameScores = (_n, cands) => new Map(cands.map((x) => [x.id, 0.1]));
      const c = chat();
      await c.photo("Las Palmas", understood([complete()], { nombreRestaurante: "Las Palmas" }));
      assert.ok(!/¿Hablo con/.test(c.reply), c.reply);
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
    });

    it("un ticket con dos direcciones: pregunta a cuál va, con botones, y sigue con la elegida completa", async () => {
      await registered();
      const c = chat();
      await c.photo(
        "",
        understood([
          complete({ direccionEntrega: "Cra 10 # 5-20, Los Robles", detalleDireccion: "Torre 4 apt 106", esConjunto: true, direccionAlterna: "Cra 12 # 8-30, Unidad Las Palmas, Torre 2 Apt 707" }),
        ]),
      );
      assert.match(c.reply, /^En el ticket veo dos direcciones para Marta Ríos 🤔 \*1\.\* Cra 10 # 5-20, Los Robles · Torre 4 apt 106 \*2\.\* Cra 12 # 8-30, Unidad Las Palmas · Torre 2 Apt 707 ¿A cuál va\?$/);
      assert.deepEqual(c.replyButtons.map((b) => b.title), ["La 1", "La 2"]);
      assert.deepEqual(geocodeCalls, [], "no ubica nada antes de saber cuál");

      await c.press(c.replyButtons[1].id);
      const d = (await c.draft())?.entregas[0];
      assert.equal(d?.direccionEntrega, "Cra 12 # 8-30, Unidad Las Palmas");
      assert.equal(d?.detalleDireccion, "Torre 2 Apt 707");
      assert.equal(d?.direccionAlterna, null);
      assert.deepEqual(geocodeCalls, ["Cra 12 # 8-30, Unidad Las Palmas"]);
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
    });

    it("a «¿A cuál va?» responde escrito («la de Las Palmas»): sigue con esa sin volver a preguntar", async () => {
      await registered();
      const c = chat();
      const two = complete({ direccionEntrega: "Cra 10 # 5-20, Los Robles", detalleDireccion: "Torre 4 apt 106", esConjunto: true, direccionAlterna: "Cra 12 # 8-30, Unidad Las Palmas, Torre 2 Apt 707" });
      await c.photo("", understood([two]));
      assert.match(c.reply, /¿A cuál va\?$/);
      // El modelo ya recibe el borrador con la elegida: la devuelve igual.
      await c.say("la de las palmas", understood([complete({ direccionEntrega: "Cra 12 # 8-30, Unidad Las Palmas", detalleDireccion: "Torre 2 Apt 707", esConjunto: true })]));
      assert.equal(modelCalls.at(-1)?.draft.entregas[0].direccionEntrega, "Cra 12 # 8-30, Unidad Las Palmas");
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
    });

    it("si el restaurante dice cuál con texto, el modelo la elige y no se pregunta", async () => {
      await registered();
      const c = chat();
      await c.photo("Las Palmas", understood([complete({ direccionEntrega: "Cra 12 # 8-30, Unidad Las Palmas", detalleDireccion: "Torre 2 Apt 707", esConjunto: true })]));
      assert.ok(!/dos direcciones/.test(c.reply));
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
    });
  });

  describe("banco de conversaciones reales (16 patrones)", () => {
    it("caso 1: solicitud directa con datos del cliente, tiempo de preparación y luego «ya está listo»", async () => {
      await registered();
      const c = chat();
      await c.say("Hola, tenemos domi: Nombre, Teléfono, Dirección. En 8 minutos tenemos el pedido listo", understood([complete({ listoEnMinutos: 8 })]));
      assert.match(c.reply, /Lista en 8 min/);
      await c.press(order.CONFIRM_BUTTON_ID);
      const [trip] = await allTrips();
      assert.ok(trip.readyAt);
      await c.say("Hola, el pedido ya está listo, gracias", understood([delivery({ listoEnMinutos: 0 })]));
      assert.match(c.reply, /la comida ya está lista/);
      assert.equal((await allTrips()).length, 1, "«ya está listo» no es otro domicilio");
    });

    it("caso 2: solicitud con el tiempo de preparación incluido desde el principio", async () => {
      await registered();
      const c = chat();
      await c.say("Hola, tenemos domi. En 18 minutos tenemos el pedido listo", understood([complete({ listoEnMinutos: 18 })]));
      assert.match(c.reply, /Lista en 18 min/);
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
    });

    it("caso 3: dirección dudosa: pregunta a la central, la corrige sin perder los demás datos y el tiempo llega después", async () => {
      await registered();
      geocodes.set("Carrera 83B #14A-121, barrio El Ingenio", { kind: "not_found" });
      const c = chat();
      await c.say(
        "Hola, tenemos domi. Dirección: Carrera 83B #14A-121, barrio El Ingenio, edificio blanco, apartamento 402.",
        understood([complete({ direccionEntrega: "Carrera 83B #14A-121, barrio El Ingenio", detalleDireccion: "Edificio blanco apto 402", listoEnMinutos: null })]),
      );
      await assertEscalated(c, /^Consulta de dirección:/, "kept");
      await advisor.answerAdvisorQuery((await c.conversation()).id, [{ indice: 0, valida: true, precio: 8_000, direccion: "Carrera 83C #14A-121, El Ingenio" }]);
      assert.match(c.reply, /¿En cuánto tiempo está listo el pedido\?/, "falta el tiempo y se pide");
      const draft = await c.draft();
      assert.equal(draft?.entregas[0].detalleDireccion, "Edificio blanco apto 402");
      assert.equal(draft?.entregas[0].nombreCliente, "Marta Ríos");

      await c.say("En 20 minutos sale, gracias", understood([complete({ direccionEntrega: "Carrera 83C #14A-121, El Ingenio", detalleDireccion: "Edificio blanco apto 402", listoEnMinutos: 20 })]));
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      assert.match(c.reply, /\$ ?8\.000/, "el precio del asesor se conserva");
    });

    it("caso 4: varias solicitudes simultáneas: «5 cada uno» y «sí, ya están los 2» no se leen como una sola entrega", async () => {
      await registered();
      const c = chat();
      await c.say(
        "dos domis",
        understood([complete({ direccionEntrega: "Calle 10 # 5-20", nombreCliente: "Marta" }), complete({ direccionEntrega: "Carrera 8 # 9-10", nombreCliente: "Luis", telefonoCliente: "3109998877" })]),
      );
      assert.match(c.reply, /Serían 2 domicilios/);
      assert.equal((c.reply.match(/• [^•]*?\$ ?5\.000/g) ?? []).length, 2, "«5 cada uno»");
      assert.match(c.reply, /Total: \$ ?10\.000/);
      await c.say("Sí, ya están los 2", understood([complete({ nombreCliente: "Marta" }), complete({ direccionEntrega: "Carrera 8 # 9-10", nombreCliente: "Luis", telefonoCliente: "3109998877" })], { confirms: true }));
      assert.equal((await allTrips()).length, 2);
    });

    it("caso 5: precio y luego «sí, ya está»: confirma el pedido cotizado", async () => {
      await registered();
      const c = chat();
      await c.say("[datos del cliente, dirección y conjunto]", understood([complete()]));
      await c.say("Sí, ya está.", understood([complete()], { confirms: true }));
      assert.equal((await allTrips()).length, 1);
    });

    it("caso 6: precio y «ya está» (disponibilidad inmediata): confirma una sola vez", async () => {
      await registered();
      const c = chat();
      await c.say("[datos, sector Caney]", understood([complete()]));
      await c.say("Ya está.", understood([complete({ listoEnMinutos: 0 })], { confirms: true }));
      // «Ya está» trae listoEnMinutos 0, que cambia el pedido mostrado: se le muestra de nuevo.
      assert.equal((await allTrips()).length, 0);
      assert.match(c.reply, /Ya está lista/);
      await c.press(order.CONFIRM_BUTTON_ID);
      assert.equal((await allTrips()).length, 1);
    });

    it("caso 7: dirección, unidad, apto y «en 10» en mensajes breves: se juntan y no se repregunta", async () => {
      await registered();
      const c = chat();
      await c.say(
        "Dirección y barrio: Calle 10 # 5-20, Ciudad Jardín.\nUnidad residencial Bosques.\nApartamento 705, torre A.\n\nEn 10.",
        understood([complete({ direccionEntrega: "Calle 10 # 5-20, Ciudad Jardín", detalleDireccion: "Torre A apto 705", esConjunto: true, listoEnMinutos: 10 })]),
      );
      assert.match(c.reply, /Torre A apto 705/);
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      assert.equal(modelCalls.length, 1);
    });

    it("caso 8: «Hola, buenas» primero y los datos después: el saludo no cuenta como intento fallido", async () => {
      await registered();
      const c = chat();
      await c.raw((head) => ({ ...head, kind: "text", text: "Hola, buenas." }));
      assert.match(c.reply, /¿Para dónde necesitas el servicio hoy\?/);
      assert.equal(modelCalls.length, 0, "un saludo suelto no pasa por el modelo");
      assert.equal((await c.conversation()).failedAttempts, 0);
      await c.say("Calle 10 # 5-20\nConjunto Bosques apto 301\n3001234567\nMarta Ríos\nEn 10", understood([complete({ detalleDireccion: "Apto 301" })]));
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      await assertNotEscalated(c);
    });

    it("caso 9: un mensaje reenviado con la ubicación (pin) arma la entrega y «ya está listo» después actualiza el pedido", async () => {
      await registered();
      const c = chat();
      await c.pin(NEAR.lat, NEAR.lng, "Centro Comercial Aquarela, local 12");
      assert.equal((await c.draft())?.entregas[0].direccionUbicada, "Centro Comercial Aquarela, local 12");
      await c.say("Marta, 3001234567, en 10", understood([complete({ direccionEntrega: "Centro Comercial Aquarela, local 12" })]));
      await c.press(order.CONFIRM_BUTTON_ID);
      const [trip] = await allTrips();
      assert.equal(trip.deliveryAddress, "Centro Comercial Aquarela, local 12");
      await c.say("Ya está listo, pueden venir porfa", understood([delivery({ listoEnMinutos: 0 })]));
      assert.equal((await allTrips()).length, 1);
      assert.match(c.reply, /la comida ya está lista/);
    });

    it("caso 10: «¿Domis acá?» solo con un barrio: pide la dirección o la ubicación, sin pedido ni escalar", async () => {
      await registered();
      const c = chat();
      await c.say("¿Domis acá?", understood([], { query: "cobertura" }));
      assert.match(c.reply, /Envíame la dirección o la ubicación y te digo si llegamos y cuánto vale/);
      assert.equal((await allTrips()).length, 0);
      await assertNotEscalated(c);
    });

    it("caso 11: «¿Qué vale el domicilio a la Clínica Farallones?» es una cotización, no una solicitud", async () => {
      await registered();
      geocodes.set("Clínica Farallones", { kind: "found", location: FAR, neighborhood: "Farallones" });
      const c = chat();
      await c.say("¿Qué vale el domicilio aquí a la Clínica Farallones?", understood([delivery({ direccionEntrega: "Clínica Farallones" })], { intent: "cotizar" }));
      assert.match(c.reply, /Hasta Farallones el domicilio vale \$ ?8\.000/);
      assert.equal(c.replyButtons.length, 0);
      assert.equal((await allTrips()).length, 0);
    });

    it("caso 12: «El pedido ya está listo» no crea otro domicilio; con varios posibles, pregunta a cuál", async () => {
      await registered();
      const c = chat();
      await placeOrder(c, { direccionEntrega: "Calle 10 # 5-20" });
      await c.say("El pedido ya está listo.", understood([delivery({ listoEnMinutos: 0 })]));
      assert.match(c.reply, /Anotado ✅/);
      assert.equal((await allTrips()).length, 1);

      await placeOrder(c, { direccionEntrega: "Carrera 8 # 9-10", nombreCliente: "Luis" });
      await c.say("El pedido ya está listo.", understood([delivery({ listoEnMinutos: 0 })]));
      assert.match(c.reply, /¿De cuál pedido hablas\?/);
      assert.equal((await allTrips()).length, 2);
    });

    it("caso 13: «¿El domicilio ya llegó?» es una consulta: se responde y no cambia el pedido ni escala", async () => {
      await registered();
      const c = chat();
      const trip = await placeOrder(c);
      const before = outbox.length;
      await c.say("¿El domicilio ya llegó?", understood([], { query: "estado" }));
      assert.ok(outbox.length > before, "se le responde algo del servicio");
      assert.equal((await allTrips()).length, 1);
      assert.equal((await allTrips())[0].status, trip.status);
      await assertNotEscalated(c);
    });

    it("caso 14: efectivo con billete de 100 mil y «2 hamburguesas»: van como notas y pago, no como campos obligatorios", async () => {
      await registered();
      const c = chat();
      await c.say(
        "[datos] Efectivo con billete de 100 mil. 2 hamburguesas cheese.",
        understood([complete({ metodoPago: "efectivo", valorACobrar: 45_000, notas: "Billete de 100 mil. 2 hamburguesas cheese" })]),
      );
      assert.deepEqual(c.replyButtons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      assert.match(c.reply, /Billete de 100 mil/);
      await c.press(order.CONFIRM_BUTTON_ID);
      const [trip] = await allTrips();
      assert.equal(trip.notes, "Billete de 100 mil. 2 hamburguesas cheese");
      assert.equal(trip.paymentMethod, "efectivo");
      assert.equal(trip.valueToCollect, 45_000);
      assert.equal(trip.requiresCashReturn, true);
    });

    it("caso 15: nombre, dirección, teléfono y «en 10»: pedido completo con el tiempo contado desde el mensaje", async () => {
      await registered();
      const c = chat();
      const at = new Date(OPEN_AT + 60_000);
      await c.say("Nombre: Marta\nDirección: Calle 10 # 5-20\nTeléfono: 3001234567\nEn 10.", understood([complete({ listoEnMinutos: 10 })]), { at });
      await c.press(order.CONFIRM_BUTTON_ID);
      const [trip] = await allTrips();
      assert.equal(trip.readyAt?.getTime(), at.getTime() + 10 * 60_000);
    });

    it("caso 16: consulta de precio que evoluciona a solicitud efectiva: no duplica viajes", async () => {
      await registered();
      const c = chat();
      await c.say("¿Qué vale el domicilio aquí a Calle 10 # 5-20?", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })], { intent: "cotizar" }));
      assert.equal(c.replyButtons.length, 0);
      // «Ya está listo, pueden venir por él» con los datos del cliente: ahora sí es un pedido.
      await c.say("Marta, 3001234567. Ya está listo, pueden venir por él", understood([complete({ listoEnMinutos: 0 })], { intent: "pedir" }));
      assert.equal((await c.draft())?.soloPrecio, false);
      await c.press(order.CONFIRM_BUTTON_ID);
      assert.equal((await allTrips()).length, 1);
    });
  });

  describe("saludo del día y presentación (#121)", () => {
    const AFTERNOON = "¡Buenas tardes! Gracias por confiar en Express Cali 🙌";
    const IDENTITY =
      "Soy un asistente implementado por Clapi Solutions, una empresa líder en automatizaciones que ayuda a Express Cali a mejorar sus flujos y tiempos de trabajo, agilizando la toma de servicios y brindando la mejor atención posible.";
    const raw = (sent: Sent[]) => sent.map((s) => s.text.replace(/\u00a0/g, " "));
    const text = (c: ReturnType<typeof chat>, body: string) => c.raw((head) => ({ ...head, kind: "text", text: body }));
    /** Lo que se le escribió quedó «ayer»: el próximo mensaje es el primero del día. */
    const yesterday = () => db.update(schema.messages).set({ createdAt: new Date("2020-01-01T12:00:00Z") });

    it("el primer mensaje del día lleva el saludo encima de la cotización, en un solo envío", async () => {
      await registered();
      const c = chat();
      const first = await c.say("domi a la calle 10 # 5-20", understood([complete()]));
      assert.equal(first.sent.length, 1, "un solo mensaje de WhatsApp");
      assert.ok(raw(first.sent)[0].startsWith(`${AFTERNOON}\n\n`), "el saludo va arriba, separado por una línea");
      assert.deepEqual(first.sent[0].buttons.map((b) => b.id), [order.CONFIRM_BUTTON_ID], "y con el botón de la cotización");
    });

    it("el segundo mensaje del mismo día no repite el saludo", async () => {
      await registered();
      const c = chat();
      await c.say("domi a la calle 10 # 5-20", understood([complete()]));
      const second = await c.say("y otro a la carrera 5", understood([complete(), complete({ direccionEntrega: "Carrera 5 # 1-10" })]));
      assert.ok(second.sent.length > 0);
      for (const t of raw(second.sent)) assert.ok(!t.includes("Gracias por confiar en Express Cali"), t);
    });

    it("al otro día vuelve a saludar", async () => {
      await registered();
      const c = chat();
      await c.say("domi a la calle 10 # 5-20", understood([complete()]));
      await yesterday();
      const next = await c.say("y otro a la carrera 5", understood([complete(), complete({ direccionEntrega: "Carrera 5 # 1-10" })]));
      assert.ok(raw(next.sent)[0].startsWith(AFTERNOON));
    });

    it("de mañana dice «Buenos días», también si el mensaje es que todavía no abren", async () => {
      await registered();
      const c = chat();
      const r = await c.say("domi a la calle 10 # 5-20", understood([complete()]), { at: new Date(MORNING_AT) });
      assert.ok(raw(r.sent)[0].startsWith("¡Buenos días! Gracias por confiar en Express Cali 🙌\n\n"), raw(r.sent)[0]);
    });

    it("un «hola» suelto: saludo y para dónde es el servicio, sin el modelo, sin intentos y sin la central", async () => {
      await registered();
      const c = chat();
      const r = await text(c, "Hola, buenas tardes 👋");
      assert.deepEqual(raw(r.sent), [`${AFTERNOON}\n\n¿Para dónde necesitas el servicio hoy? 🛵`]);
      assert.equal(modelCalls.length, 0);
      assert.equal((await c.conversation()).failedAttempts, 0);
      await assertNotEscalated(c);
      // Otro «hola» el mismo día: sin saludo, y tampoco suma intentos.
      const again = await text(c, "hola");
      assert.deepEqual(raw(again.sent), ["¿Para dónde necesitas el servicio hoy? 🛵"]);
      assert.equal((await c.conversation()).failedAttempts, 0);
      await assertNotEscalated(c);
    });

    it("un «hola» con un pedido a medio armar no lo borra ni suma intentos", async () => {
      await registered();
      const c = chat();
      await c.say("domi a la calle 10", understood([delivery({ direccionEntrega: "Calle 10 # 5-20" })]));
      const before = await c.draft();
      const r = await text(c, "holaa");
      assert.deepEqual(raw(r.sent), ["¡Hola! 🙌 Aquí sigo con tu pedido."]);
      assert.deepEqual(await c.draft(), before);
      assert.equal((await c.conversation()).failedAttempts, 0);
    });

    it("«¿quién eres?»: se presenta como el asistente de Clapi Solutions, sin el modelo y sin la central", async () => {
      await registered();
      const c = chat();
      const r = await text(c, "Buenas, ¿con quién hablo?");
      assert.deepEqual(raw(r.sent), [`${AFTERNOON}\n\n${IDENTITY} ¿En qué te puedo colaborar hoy?`]);
      assert.equal(modelCalls.length, 0);
      assert.equal((await c.conversation()).failedAttempts, 0);
      await assertNotEscalated(c);
      const again = await text(c, "¿eres un bot?");
      assert.deepEqual(raw(again.sent), [`${IDENTITY} ¿En qué te puedo colaborar hoy?`]);
    });

    it("si pregunta quién es y además pide, se presenta y sigue con el pedido", async () => {
      await registered();
      const c = chat();
      const r = await c.say("¿eres un bot? necesito un domi a la calle 10 # 5-20", understood([complete()]));
      assert.equal(r.sent.length, 2);
      assert.equal(raw(r.sent)[0], `${AFTERNOON}\n\n${IDENTITY}`, "la presentación sin la pregunta del final: el pedido sigue");
      assert.deepEqual(r.sent[1].buttons.map((b) => b.id), [order.CONFIRM_BUTTON_ID]);
      assert.equal(modelCalls.length, 1);
    });

    it("si no pregunta quién es, nunca sale la presentación", async () => {
      await registered();
      const c = chat();
      const r = await c.say("domi a la calle 10 # 5-20 para un bot de cumpleaños", understood([complete()]));
      for (const t of raw(r.sent)) assert.ok(!t.includes("Clapi Solutions"), t);
    });
  });
});
