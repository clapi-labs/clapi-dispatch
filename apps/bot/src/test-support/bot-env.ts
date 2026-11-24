import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
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

export type Sent = {
  phone: string;
  text: string;
  buttons: { id: string; title: string }[];
  replyTo: string | null;
  wamid: string;
  video?: { id?: string; link?: string };
};

export const outbox: Sent[] = [];
/** Archivos subidos vía `uploadMedia` durante la prueba. */
export const uploadedMedia: { mimeType: string; filename: string; bytes: number; id: string }[] = [];
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

// ---------------------------------------------------------------------------
// El engine (HTTP): `POST {ENGINE_URL}/evaluar`
// ---------------------------------------------------------------------------

/** Lo que el bot le manda a `/evaluar` (docs/ALGORITMO.md), lo justo para armar una respuesta. */
export type EngineRequest = {
  ahora: number;
  pedido: { id: number; listo_ts: number };
  motos: { id: string; sin_senal: boolean }[];
};
export type EngineResponseBody = {
  engine_version: string;
  despacho: { despachar_ts: number; faltan_min: number };
  ganador: string | null;
  plan: { tipo: "R" | "C" | "W" | "V" | "B"; pedido: number | null; motivo?: "datafono" | "plata" }[] | null;
  motos: { id: string; elegible: boolean; motivo: string | null }[];
};
/** Qué contesta el engine: un cuerpo, un error HTTP, una caída de red o un timeout. */
export type EngineReply =
  | EngineResponseBody
  | { http: number; body?: unknown }
  | "network"
  | "timeout"
  | "badjson";

/** Un engine mínimo y determinista: gana la primera moto con señal y se despacha de una si la comida está lista en menos de 10 minutos. */
export function fakeEngine(request: EngineRequest): EngineResponseBody {
  const eligible = request.motos.filter((m) => !m.sin_senal);
  const winner = eligible[0]?.id ?? null;
  const faltan = Math.max(0, Math.ceil((request.pedido.listo_ts - request.ahora) / 60) - 10);
  return {
    engine_version: "fake-1",
    despacho: { despachar_ts: request.ahora + faltan * 60, faltan_min: faltan },
    ganador: winner,
    plan: winner === null ? null : [{ tipo: "R", pedido: request.pedido.id }, { tipo: "C", pedido: request.pedido.id }],
    motos: request.motos.map((m) => ({ id: m.id, elegible: !m.sin_senal, motivo: m.sin_senal ? "sin_senal" : null })),
  };
}

// El engine de verdad: el servicio Python de apps/engine (solo librería estándar), levantado como proceso.
let realFetch: typeof fetch | null = null;

/** Qué intérprete de Python hay en esta máquina (el engine solo usa la librería estándar); `null` si ninguno. */
export function findPython(): string | null {
  for (const command of ["python3", "python"]) {
    const found = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (found.status === 0 && /Python 3/.test(`${found.stdout}${found.stderr}`)) return command;
  }
  return null;
}

/** Un puerto libre. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Levanta el engine real (`apps/engine/api.py`) y espera a que conteste `/health`. Mientras esté
 * `ENGINE_URL` apuntando a su `url`, lo que el bot le pregunta a `/evaluar` va a él y no al engine de mentiras
 * (el engine de mentiras vive en otra URL). `stop()` lo apaga.
 */
export async function startRealEngine(): Promise<{ url: string; version: string; stop: () => Promise<void> }> {
  const python = findPython();
  if (!python) throw new Error("No hay Python 3 para levantar el engine real");
  if (!realFetch) throw new Error("installMocks() primero");
  const port = await freePort();
  const script = path.resolve(process.cwd(), "apps/engine/api.py");
  const child: ChildProcess = spawn(python, [script], { env: { ...process.env, PORT: String(port), PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (d) => (output += String(d)));
  child.stderr?.on("data", (d) => (output += String(d)));
  const url = `http://127.0.0.1:${port}`;
  let version = "";
  for (let attempt = 0; attempt < 100 && !version; attempt++) {
    if (child.exitCode !== null) throw new Error(`El engine real se cerró al arrancar: ${output}`);
    try {
      const health = await realFetch(`${url}/health`);
      if (health.ok) version = ((await health.json()) as { engine_version: string }).engine_version;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!version) {
    child.kill();
    throw new Error(`El engine real no contestó /health: ${output}`);
  }
  return {
    url,
    version,
    stop: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    },
  };
}

let engineHandler: ((request: EngineRequest) => EngineReply | Promise<EngineReply>) | null = null;
export const engineCalls: EngineRequest[] = [];
/** Cambia lo que contesta el engine (por defecto, `fakeEngine`); `null` lo devuelve a lo de siempre. */
export const engine = {
  reply(handler: ((request: EngineRequest) => EngineReply | Promise<EngineReply>) | EngineReply | null) {
    engineHandler = handler === null ? null : typeof handler === "function" ? handler : () => handler;
  },
};

async function engineFetch(init?: { body?: unknown }): Promise<Response> {
  const request = JSON.parse(String(init?.body ?? "{}")) as EngineRequest;
  engineCalls.push(request);
  const reply = await (engineHandler ? engineHandler(request) : fakeEngine(request));
  if (reply === "network") throw new TypeError("fetch failed");
  if (reply === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  if (reply === "badjson") return new Response("<html>502</html>", { status: 200 });
  if ("http" in reply) return new Response(JSON.stringify(reply.body ?? { error: "falló" }), { status: reply.http, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
}

let sentSeq = 0;
let uploadSeq = 0;
let failSends = false;
let failUploads = false;
let throwSends = false;
const failingReads = new Set<string>();
let failBody: unknown = null;
/** Hace que WhatsApp rechace los envíos (para probar que el estado igual se guarda),
 *  con el cuerpo de error que devolvería Meta. */
export const whatsapp = {
  failSends(on: boolean, body: unknown = null) {
    failSends = on;
    failBody = body;
  },
  failUploads(on: boolean) {
    failUploads = on;
  },
  /** Que enviar lance una excepción (no solo que Meta rechace el envío). */
  throwSends(on: boolean) {
    throwSends = on;
  },
  /** Que marcar como leído ese mensaje falle (lo primero que hace el bot con un mensaje de un motorizado). */
  failReadOf(wamid: string) {
    failingReads.add(wamid);
  },
};

export async function installMocks() {
  const client = await import("@/services/whatsapp/client");
  const record = (
    phone: string,
    text: string,
    buttons: { id: string; title: string }[] = [],
    replyTo: string | null = null,
    video?: { id?: string; link?: string },
  ) => {
    if (throwSends) throw new Error("WhatsApp no respondió");
    if (failSends) return { ok: false as const, reason: "http_error" as const, status: 500, body: failBody };
    const wamid = `wamid.out.${++sentSeq}`;
    outbox.push({ phone, text, buttons, replyTo, wamid, ...(video ? { video } : {}) });
    return { ok: true as const, messageId: wamid };
  };
  mock.module("@/services/whatsapp/client", {
    namedExports: {
      ...client,
      sendText: async (phone: string, text: string, o?: { replyTo?: string | null }) => record(phone, text, [], o?.replyTo ?? null),
      sendButtons: async (phone: string, text: string, buttons: { id: string; title: string }[], o?: { replyTo?: string | null }) =>
        record(phone, text, buttons, o?.replyTo ?? null),
      sendList: async (phone: string, text: string, _list: unknown, o?: { replyTo?: string | null }) => record(phone, text, [], o?.replyTo ?? null),
      sendVideo: async (phone: string, video: { id?: string; link?: string }, caption?: string, o?: { replyTo?: string | null }) =>
        record(phone, caption ?? "", [], o?.replyTo ?? null, video),
      uploadMedia: async (bytes: Buffer, mimeType: string, filename: string) => {
        if (failUploads) return null;
        const id = `media.up.${++uploadSeq}`;
        uploadedMedia.push({ mimeType, filename, bytes: bytes.length, id });
        return id;
      },
      markRead: async (wamid: string) => {
        if (failingReads.has(wamid)) throw new Error("WhatsApp no respondió");
        marked.push({ wamid, typing: false });
      },
      markReadAndTyping: async (wamid: string) => void marked.push({ wamid, typing: true }),
    },
  });

  realFetch ??= globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-prueba-sin-red";
  mock.method(globalThis, "fetch", async (url: unknown, init?: { body?: unknown }) => {
    const target = String(url instanceof Request ? url.url : url);
    if (target.includes("/evaluar")) return realFetch && target.startsWith("http://127.0.0.1") ? realFetch(url as string, init as RequestInit) : engineFetch(init);
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
  uploadedMedia.length = 0;
  marked.length = 0;
  classifierQueue.length = 0;
  classified.length = 0;
  failSends = false;
  failUploads = false;
  throwSends = false;
  failBody = null;
  failingReads.clear();
  engineHandler = null;
  engineCalls.length = 0;
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

// ---------------------------------------------------------------------------
// Despacho: una moto con GPS en vivo y pedidos pendientes listos para evaluar
// ---------------------------------------------------------------------------

/** Una moto conectada con GPS de hace un instante (lo que el engine necesita para tenerla en cuenta). */
export const liveCourier = (over: Parameters<typeof createCourier>[0] = {}): Parameters<typeof createCourier>[0] => ({
  status: "available",
  lat: PICKUP.lat,
  lng: PICKUP.lng,
  locationUpdatedAt: new Date(),
  locationMoving: true,
  ...over,
});

/** Un pedido pendiente con todo lo que el engine pide (ubicaciones y hora de listo). Listo en 5 minutos: se despacha ya. */
export async function pendingTrip(w: World, over: Parameters<typeof createTrip>[0] = {}) {
  const n = ++seq;
  return createTrip({
    status: "pending",
    conversationId: w.restaurantConversation.id,
    restaurantId: w.restaurant.id,
    originRestaurantName: w.restaurant.name,
    pickupAddress: "Calle 5 # 38-10",
    pickupLocation: PICKUP,
    deliveryAddress: "Calle 10 # 5-20",
    deliveryLocation: DELIVERY,
    customerName: "Marta Ríos",
    customerPhone: "3001234567",
    sourceWaMessageId: `wamid.src.${n}`,
    code: `P-${String(n).padStart(2, "0")}`,
    readyAt: new Date(Date.now() + 5 * 60_000),
    deliveryFee: 5_000,
    ...over,
  });
}
