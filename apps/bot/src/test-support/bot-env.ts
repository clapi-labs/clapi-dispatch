import { mock } from "node:test";

import { eq } from "drizzle-orm";

import { assignTripTo, db, schema } from "@dispatch/shared/db";
import { createConversation, createCourier, createRestaurant, createTrip } from "@dispatch/shared/db/test-db";

import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * Lo común de las pruebas del flujo del motorizado y de los avisos (`courier.test.ts`,
 * `notify.test.ts`): lo que sale del proceso, simulado, y el armado de un
 * motorizado con su restaurante y sus viajes en la base de pruebas.
 *
 * - WhatsApp: no se envía nada; cada mensaje que el bot manda queda en `outbox`.
 * - OpenAI: no se llama. `classifyCourierMessage` es la de verdad, pero su
 *   `fetch` es el de aquí: se le dice qué contestar (`classifier`) o cómo
 *   fallar, y así se prueba también su respaldo cuando OpenAI cae.
 *
 * `installMocks()` va en el `before` del archivo y hay que importar el bot
 * después (`await import(...)`): un módulo importado antes ya tiene el WhatsApp
 * de verdad.
 */

export type Sent = { phone: string; text: string; buttons: { id: string; title: string }[]; replyTo: string | null; wamid: string };

export const outbox: Sent[] = [];
/** Los mensajes que el bot marcó como leídos (y si además mostró «escribiendo…»). */
export const marked: { wamid: string; typing: boolean }[] = [];

/** `$ 5.000` sale con espacio duro en es-CO: se compara con espacio normal. */
export const plain = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

/** Lo que el bot le escribió a ese número, en orden. */
export const sentTo = (phone: string) => outbox.filter((m) => m.phone === phone);

export type ClassifierAnswer = { tipo: string; resumen?: string | null } | "network" | "http500" | "badjson" | "empty";

const classifierQueue: ClassifierAnswer[] = [];
/** Los textos que se mandaron a clasificar (a OpenAI). */
export const classified: string[] = [];

/** Lo que contestará OpenAI en la próxima clasificación. */
export const classifier = {
  next(answer: ClassifierAnswer) {
    classifierQueue.push(answer);
  },
};

let sentSeq = 0;
let failSends = false;
let failBody: unknown = null;
/** Hace que WhatsApp rechace los envíos (para probar que el estado igual se guarda),
 *  con el cuerpo de error que devolvería Meta. */
export const whatsapp = {
  failSends(on: boolean, body: unknown = null) {
    failSends = on;
    failBody = body;
  },
};

export async function installMocks() {
  const client = await import("@/services/whatsapp/client");
  const record = (phone: string, text: string, buttons: { id: string; title: string }[] = [], replyTo: string | null = null) => {
    if (failSends) return { ok: false as const, reason: "http_error" as const, status: 500, body: failBody };
    const wamid = `wamid.out.${++sentSeq}`;
    outbox.push({ phone, text, buttons, replyTo, wamid });
    return { ok: true as const, messageId: wamid };
  };
  mock.module("@/services/whatsapp/client", {
    namedExports: {
      ...client,
      sendText: async (phone: string, text: string, o?: { replyTo?: string | null }) => record(phone, text, [], o?.replyTo ?? null),
      sendButtons: async (phone: string, text: string, buttons: { id: string; title: string }[], o?: { replyTo?: string | null }) =>
        record(phone, text, buttons, o?.replyTo ?? null),
      sendList: async (phone: string, text: string, _list: unknown, o?: { replyTo?: string | null }) => record(phone, text, [], o?.replyTo ?? null),
      markRead: async (wamid: string) => void marked.push({ wamid, typing: false }),
      markReadAndTyping: async (wamid: string) => void marked.push({ wamid, typing: true }),
    },
  });

  process.env.OPENAI_API_KEY = "sk-prueba-sin-red";
  mock.method(globalThis, "fetch", async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
    classified.push(body.messages?.find((m) => m.role === "user")?.content ?? "");
    const answer = classifierQueue.shift();
    if (!answer) return new Response("sin respuesta preparada", { status: 599 });
    if (answer === "network") throw new TypeError("fetch failed");
    if (answer === "http500") return new Response("error", { status: 500 });
    const content = answer === "badjson" ? "esto no es json" : answer === "empty" ? "" : JSON.stringify({ tipo: answer.tipo, resumen: answer.resumen ?? null });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

export function resetMocks() {
  outbox.length = 0;
  marked.length = 0;
  classifierQueue.length = 0;
  classified.length = 0;
  failSends = false;
  failBody = null;
}

export function restoreMocks() {
  mock.restoreAll();
}

// ---------------------------------------------------------------------------
// Armar el mundo: un motorizado, su restaurante y sus viajes
// ---------------------------------------------------------------------------

export const PICKUP = { lat: 3.45, lng: -76.53 };
export const DELIVERY = { lat: 3.46, lng: -76.52 };

let seq = 0;

export type World = Awaited<ReturnType<typeof world>>;

/** Un motorizado con su conversación, y un restaurante con la suya. */
export async function world(over: { courier?: Parameters<typeof createCourier>[0]; restaurantName?: string } = {}) {
  const courier = await createCourier({ name: "Pedro Gómez", status: "available", ...over.courier });
  const courierConversation = await createConversation({ phone: courier.phone });
  const restaurantConversation = await createConversation({ displayName: over.restaurantName ?? "Pizza Nona" });
  const restaurant = await createRestaurant({
    name: over.restaurantName ?? "Pizza Nona",
    phone: restaurantConversation.phone,
    knownPickupAddress: "Calle 5 # 38-10",
    knownPickupLocation: PICKUP,
  });
  return { courier, courierConversation, restaurantConversation, restaurant };
}

/**
 * Un pedido ya asignado a la moto, como lo deja el despacho (`assignTripTo`): el
 * viaje en ruta, la moto ocupada y su asignación. `over` cambia el viaje.
 */
export async function assignedTrip(w: World, over: Parameters<typeof createTrip>[0] = {}, who: { courier?: World["courier"] } = {}) {
  const n = ++seq;
  const trip = await createTrip({
    conversationId: w.restaurantConversation.id,
    restaurantId: w.restaurant.id,
    originRestaurantName: w.restaurant.name,
    pickupAddress: "Calle 5 # 38-10",
    pickupLocation: PICKUP,
    deliveryAddress: "Calle 10 # 5-20 · Torre 2 apto 301",
    deliveryLocation: DELIVERY,
    customerName: "Marta Ríos",
    customerPhone: "3001234567",
    sourceWaMessageId: `wamid.src.${n}`,
    code: `A-${String(n).padStart(2, "0")}`,
    ...over,
  });
  const courier = who.courier ?? w.courier;
  const assigned = await assignTripTo(trip.id, courier.id);
  if (!assigned) throw new Error("assignTripTo no asignó el viaje de prueba");
  return { trip: await getTrip(trip.id), assignment: await getAssignment(trip.id) };
}

export const getTrip = async (id: number) => (await db.select().from(schema.trips).where(eq(schema.trips.id, id)))[0];
export const getAssignment = async (tripId: number) => (await db.select().from(schema.assignments).where(eq(schema.assignments.tripId, tripId)))[0];
export const getCourier = async (id: number) => (await db.select().from(schema.couriers).where(eq(schema.couriers.id, id)))[0];
export const getConversation = async (id: number) => (await db.select().from(schema.conversations).where(eq(schema.conversations.id, id)))[0];

/** Cambia horas de la asignación (cuándo se asignó, leyó, recogió…). */
export const setAssignment = (tripId: number, patch: Partial<typeof schema.assignments.$inferInsert>) =>
  db.update(schema.assignments).set(patch).where(eq(schema.assignments.tripId, tripId));

export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

// ---------------------------------------------------------------------------
// Lo que escribe el motorizado
// ---------------------------------------------------------------------------

let inbound = 0;
const head = (phone: string) => ({ waMessageId: `wamid.in.${++inbound}`, phone, profileName: null, timestamp: new Date() });

export const textFrom = (phone: string, text: string): IncomingMessage => ({ ...head(phone), kind: "text", text });
export const buttonFrom = (phone: string, buttonId: string): IncomingMessage => ({ ...head(phone), kind: "button", buttonId, title: buttonId });
