import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

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
  whatsapp,
  world,
  type World,
} from "@/test-support/bot-env";

/**
 * El webhook de WhatsApp (`/api/webhook/whatsapp`): lo que Meta le manda al bot.
 * Se llama a la ruta tal cual, con una `Request` firmada como Meta, contra la
 * base de pruebas y con WhatsApp simulado. `after()` de Next solo existe dentro
 * de una petición real: aquí se sustituye por una cola que cada prueba espera
 * (`settle`), que es lo que Next haría después de contestar el 200. Para que
 * no haya que esperar los 6 s con que el bot atiende a un restaurante, los
 * mensajes que se mandan son de un motorizado, que se atiende en el acto; la
 * espera del restaurante está en `bot/intake.test.ts`. Sin `TEST_DATABASE_URL`
 * se salta.
 */

type Route = typeof import("./route");
let route: Route;
const pending: Promise<unknown>[] = [];
const saved: Record<string, string | undefined> = {};
const APP_SECRET = "secreto-de-la-app-de-meta";
const VERIFY_TOKEN = "token-de-verificacion";

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  for (const key of ["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]) saved[key] = process.env[key];
  const next = await import("next/server");
  mock.module("next/server", {
    namedExports: {
      ...next,
      // Lo que Next hace tras contestar: correr el trabajo. Aquí se guarda para esperarlo.
      after: (work: (() => unknown) | Promise<unknown>) => {
        pending.push(Promise.resolve().then(typeof work === "function" ? work : () => work));
      },
    },
  });
  route = await import("./route");
});

let errors: ReturnType<typeof mock.method>;

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  pending.length = 0;
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  errors = mock.method(console, "error", () => {});
});

/** Espera lo que el webhook hace después de contestar. */
const settle = async () => {
  await Promise.all(pending.splice(0));
};
const errorLog = () => errors.mock.calls.map((c) => c.arguments.map(String).join(" ")).join("\n");

const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

/** Una entrega de Meta, firmada, con lo que se le pase. */
async function deliver(payload: unknown, opts: { signature?: string | null; raw?: string } = {}) {
  const body = opts.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  const response = await route.POST(new Request("http://bot.test/api/webhook/whatsapp", { method: "POST", headers, body }));
  await settle();
  return response;
}

type WaMsg = Record<string, unknown>;
const textMessage = (from: string, id: string, body: string, extra: WaMsg = {}): WaMsg => ({
  id,
  from,
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: "text",
  text: { body },
  ...extra,
});
const envelope = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "123", changes: [{ field: "messages", value: { messaging_product: "whatsapp", ...value } }] }],
});
const messages = (...list: WaMsg[]) => envelope({ contacts: list.map((m) => ({ wa_id: m.from, profile: { name: "Pedro P." } })), messages: list });
const statuses = (...list: Record<string, unknown>[]) => envelope({ statuses: list });

const processedIds = async () => (await db.select().from(schema.processedMessages)).map((r) => r.waMessageId).sort();
const messagesOf = (conversationId: number) => db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.id);
/** Lo que el motorizado o el restaurante escribió (no las respuestas del bot, que quedan en el mismo chat). */
const inboundOf = async (conversationId: number) => (await messagesOf(conversationId)).filter((m) => m.role === "restaurant");

describe("/api/webhook/whatsapp (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreMocks();
    await closeTestDatabase();
  });

  describe("GET: verificación al configurar el webhook en Meta", () => {
    const verify = (params: Record<string, string>) => route.GET(new Request(`http://bot.test/api/webhook/whatsapp?${new URLSearchParams(params)}`));

    it("con el token correcto devuelve el desafío como texto plano", async () => {
      const res = await verify({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "1158201444");
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    });

    for (const [name, params] of [
      ["con otro token", { "hub.mode": "subscribe", "hub.verify_token": "otro", "hub.challenge": "1" }],
      ["sin token", { "hub.mode": "subscribe", "hub.challenge": "1" }],
      ["con otro modo", { "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" }],
      ["sin desafío", { "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN }],
      ["sin nada", {}],
    ] as const) {
      it(`${name}: 403`, async () => {
        const res = await verify(params as Record<string, string>);
        assert.equal(res.status, 403);
        assert.equal(await res.text(), "Forbidden");
      });
    }
  });

  describe("POST: firma de Meta (X-Hub-Signature-256)", () => {
    async function nothingHappened(w: World) {
      assert.deepEqual(await processedIds(), []);
      assert.equal(outbox.length, 0);
      assert.equal(marked.length, 0);
      assert.equal((await messagesOf(w.courierConversation.id)).length, 0);
    }

    it("con la firma válida responde 200 y procesa el mensaje", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      const res = await deliver(messages(textMessage(w.courier.phone, "wamid.1", "ya recogí")));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "OK");
      assert.ok((await getAssignment(trip.id)).pickedUpAt, "el mensaje se atendió");
    });

    for (const [name, signature] of [
      ["sin encabezado de firma", null],
      ["con una firma que no es hexadecimal", "sha256=zzzz"],
      ["con la firma vacía", "sha256="],
      ["con otro algoritmo", "sha1=" + "ab".repeat(20)],
      ["sin el prefijo", "ab".repeat(32)],
      ["con una firma más corta", "sha256=" + "ab".repeat(8)],
    ] as const) {
      it(`${name}: 403 y no se procesa nada`, async () => {
        const w = await world();
        await assignedTrip(w);
        const res = await deliver(messages(textMessage(w.courier.phone, "wamid.1", "ya recogí")), { signature });
        assert.equal(res.status, 403);
        assert.equal(await res.text(), "Invalid signature");
        await nothingHappened(w);
      });
    }

    it("firmado con otro secreto: 403", async () => {
      const w = await world();
      const payload = messages(textMessage(w.courier.phone, "wamid.1", "ya recogí"));
      const res = await deliver(payload, { signature: sign(JSON.stringify(payload), "el-secreto-de-otro") });
      assert.equal(res.status, 403);
      await nothingHappened(w);
    });

    it("el cuerpo cambiado después de firmar: 403 (la firma es del cuerpo exacto, byte a byte)", async () => {
      const w = await world();
      const body = JSON.stringify(messages(textMessage(w.courier.phone, "wamid.1", "ya recogí")));
      const res = await deliver(null, { raw: body.replace("ya recogí", "ya recogí "), signature: sign(body) });
      assert.equal(res.status, 403);
      const spaced = await deliver(null, { raw: ` ${body}`, signature: sign(body) });
      assert.equal(spaced.status, 403);
      await nothingHappened(w);
    });

    it("una firma válida de otro cuerpo (repetida) no sirve para este", async () => {
      const w = await world();
      const other = JSON.stringify(messages(textMessage(w.courier.phone, "wamid.0", "hola")));
      const res = await deliver(messages(textMessage(w.courier.phone, "wamid.1", "ya recogí")), { signature: sign(other) });
      assert.equal(res.status, 403);
      await nothingHappened(w);
    });

    it("la firma en mayúsculas hexadecimales también vale (es la misma firma)", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      const payload = messages(textMessage(w.courier.phone, "wamid.1", "ya recogí"));
      const upper = `sha256=${sign(JSON.stringify(payload)).slice(7).toUpperCase()}`;
      assert.equal((await deliver(payload, { signature: upper })).status, 200);
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
    });
  });

  describe("POST: payloads inválidos o vacíos no rompen nada (siempre 200 con firma válida)", () => {
    for (const [name, body] of [
      ["que no es JSON", "esto no es json"],
      ["vacío", ""],
      ["un objeto vacío", "{}"],
      ["un arreglo", "[]"],
      ["null", "null"],
      ["un número", "42"],
      ["sin entradas", JSON.stringify({ object: "whatsapp_business_account", entry: [] })],
      ["con una entrada sin cambios", JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1" }] })],
      ["con un cambio sin mensajes", JSON.stringify(envelope({ contacts: [] }))],
      ["con mensajes vacíos", JSON.stringify(envelope({ messages: [], statuses: [] }))],
    ] as const) {
      it(`${name}: 200, nada se procesa y el bot sigue funcionando`, async () => {
        const w = await world();
        const { trip } = await assignedTrip(w);
        const res = await deliver(null, { raw: body });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), "OK");
        assert.deepEqual(await processedIds(), []);
        assert.equal(outbox.length, 0);
        // Después de basura, un mensaje bueno se atiende normal.
        await deliver(messages(textMessage(w.courier.phone, "wamid.ok", "ya recogí")));
        assert.ok((await getAssignment(trip.id)).pickedUpAt);
      });
    }

    it("un payload «null» se anota en el log pero no cambia la respuesta", async () => {
      await deliver(null, { raw: "null" });
      assert.match(errorLog(), /\[webhook\] fallo procesando la entrega/);
    });

    it("un mensaje sin remitente se descarta sin tocar los demás de la misma entrega", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      const res = await deliver(messages({ id: "wamid.sinfrom", timestamp: "1700000000", type: "text", text: { body: "hola" } }, textMessage(w.courier.phone, "wamid.bueno", "ya recogí")));
      assert.equal(res.status, 200);
      assert.deepEqual(await processedIds(), ["wamid.bueno"]);
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
    });

    it("un tipo de mensaje que el bot no lee (audio, sticker) se acusa y se guarda, sin romper", async () => {
      const w = await world();
      const res = await deliver(messages({ id: "wamid.audio", from: w.courier.phone, timestamp: "1700000000", type: "audio", audio: { id: "x" } }));
      assert.equal(res.status, 200);
      assert.deepEqual(await processedIds(), ["wamid.audio"]);
      assert.equal((await messagesOf(w.courierConversation.id)).length, 1, "queda en el chat para la central");
    });

    it("un mensaje sin id no tumba el endpoint (200): se anota el error", async () => {
      const w = await world();
      const res = await deliver(messages({ from: w.courier.phone, timestamp: "1700000000", type: "text", text: { body: "hola" } }));
      assert.equal(res.status, 200);
      assert.match(errorLog(), /\[webhook\] fallo procesando la entrega/);
      assert.deepEqual(await processedIds(), []);
    });
  });

  describe("POST: idempotencia (Meta reintenta y repite entregas)", () => {
    it("el mismo waMessageId dos veces se atiende una sola vez", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      const payload = messages(textMessage(w.courier.phone, "wamid.repetido", "ya recogí"));
      assert.equal((await deliver(payload)).status, 200);
      const at = (await getAssignment(trip.id)).pickedUpAt;
      const replies = outbox.length;
      assert.equal((await deliver(payload)).status, 200, "la repetida también se acusa con 200");
      assert.equal(outbox.length, replies, "no se responde otra vez");
      assert.equal((await getAssignment(trip.id)).pickedUpAt?.getTime(), at?.getTime());
      assert.equal((await inboundOf(w.courierConversation.id)).length, 1, "el mensaje queda una sola vez en el chat");
      assert.deepEqual(await processedIds(), ["wamid.repetido"]);
      assert.equal(marked.length, 1);
    });

    it("dos entregas idénticas llegando a la vez: una sola gana", async () => {
      const w = await world();
      const { trip } = await assignedTrip(w);
      const payload = messages(textMessage(w.courier.phone, "wamid.carrera", "ya recogí"));
      const body = JSON.stringify(payload);
      const post = () => route.POST(new Request("http://bot.test/api/webhook/whatsapp", { method: "POST", headers: { "x-hub-signature-256": sign(body) }, body }));
      const responses = await Promise.all([post(), post(), post()]);
      await settle();
      assert.deepEqual(responses.map((r) => r.status), [200, 200, 200]);
      assert.ok((await getAssignment(trip.id)).pickedUpAt);
      assert.equal((await inboundOf(w.courierConversation.id)).length, 1);
      assert.equal(outbox.length, 1, "un solo mensaje 2");
      assert.deepEqual(await processedIds(), ["wamid.carrera"]);
    });

    it("el mismo id dos veces dentro de una misma entrega: una sola vez", async () => {
      const w = await world();
      await assignedTrip(w);
      await deliver(messages(textMessage(w.courier.phone, "wamid.doble", "ya recogí"), textMessage(w.courier.phone, "wamid.doble", "ya recogí")));
      assert.equal((await inboundOf(w.courierConversation.id)).length, 1);
      assert.equal(outbox.length, 1);
    });

    it("ids distintos se atienden todos, aunque lleguen juntos", async () => {
      const first = await world();
      const second = await world({ courier: { name: "Luis Pérez" } });
      const a = await assignedTrip(first);
      const b = await assignedTrip(second);
      await deliver(messages(textMessage(first.courier.phone, "wamid.a", "ya recogí"), textMessage(second.courier.phone, "wamid.b", "ya recogí")));
      assert.ok((await getAssignment(a.trip.id)).pickedUpAt);
      assert.ok((await getAssignment(b.trip.id)).pickedUpAt);
      assert.deepEqual(await processedIds(), ["wamid.a", "wamid.b"]);
    });

    it("un mensaje que falla no impide atender a los otros de la misma entrega, y se contesta 200", async () => {
      const first = await world();
      const second = await world({ courier: { name: "Luis Pérez" } });
      const a = await assignedTrip(first);
      const b = await assignedTrip(second);
      whatsapp.failReadOf("wamid.malo");
      const res = await deliver(messages(textMessage(first.courier.phone, "wamid.malo", "ya recogí"), textMessage(second.courier.phone, "wamid.bueno", "ya recogí")));
      assert.equal(res.status, 200);
      assert.equal((await getAssignment(a.trip.id)).pickedUpAt, null, "el que falló no se atendió");
      assert.ok((await getAssignment(b.trip.id)).pickedUpAt, "el otro sí");
      assert.match(errorLog(), /\[webhook\] fallo procesando un mensaje/);
    });

    it("guarda el nombre de perfil de WhatsApp en la conversación", async () => {
      const w = await world();
      await deliver(messages(textMessage(w.courier.phone, "wamid.perfil", "hola")));
      const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, w.courierConversation.id));
      assert.equal(conversation.displayName, "Pedro P.");
    });
  });

  describe("POST: acuses de los mensajes nuestros (statuses)", () => {
    /** Un pedido ya avisado: el mensaje 1 quedó guardado con su wamid y su viaje. */
    async function ticketed() {
      const w = await world();
      const t = await assignedTrip(w);
      const notify = await import("@/bot/notify");
      // Al confirmar, el restaurante también recibe un mensaje (el aviso extra de asignación está apagado por defecto).
      await notify.notifyAssigned(t.trip.id, { atConfirmation: true });
      const ticket = sentTo(w.courier.phone)[0];
      outbox.length = 0;
      return { w, trip: t.trip, ticket };
    }
    const status = (id: string, kind: string, recipient: string, extra: Record<string, unknown> = {}) => ({ id, status: kind, recipient_id: recipient, ...extra });

    it("«leído» por el motorizado deja la hora en que leyó la ficha, una sola vez", async () => {
      const { w, trip, ticket } = await ticketed();
      assert.equal((await getAssignment(trip.id)).readAt, null);
      assert.equal((await deliver(statuses(status(ticket.wamid, "read", w.courier.phone)))).status, 200);
      const at = (await getAssignment(trip.id)).readAt;
      assert.ok(at);
      await new Promise((r) => setTimeout(r, 15));
      await deliver(statuses(status(ticket.wamid, "read", w.courier.phone)));
      assert.equal((await getAssignment(trip.id)).readAt?.getTime(), at.getTime(), "la repetida no la cambia");
      assert.equal(outbox.length, 0, "a un acuse nunca se le responde");
      assert.deepEqual(await processedIds(), [], "los acuses no pasan por la idempotencia de mensajes");
    });

    it("«leído» por el restaurante no cuenta como lectura del motorizado", async () => {
      const { w, trip } = await ticketed();
      const [notice] = await messagesOf(w.restaurantConversation.id);
      await deliver(statuses(status(notice.waMessageId!, "read", w.restaurantConversation.phone)));
      assert.equal((await getAssignment(trip.id)).readAt, null);
    });

    it("«entregado» o «enviado» no cambian nada", async () => {
      const { w, trip, ticket } = await ticketed();
      await deliver(statuses(status(ticket.wamid, "sent", w.courier.phone), status(ticket.wamid, "delivered", w.courier.phone)));
      assert.equal((await getAssignment(trip.id)).readAt, null);
    });

    it("un acuse de un mensaje que no conocemos se ignora sin romper", async () => {
      const { w } = await ticketed();
      const res = await deliver(statuses(status("wamid.desconocido", "read", w.courier.phone), status("wamid.otro", "failed", w.courier.phone)));
      assert.equal(res.status, 200);
    });

    it("«fallido»: lo anota en el mensaje del chat con el código de Meta, una sola vez", async () => {
      const { w, ticket } = await ticketed();
      const failed = statuses(status(ticket.wamid, "failed", w.courier.phone, { errors: [{ code: 131047, title: "Re-engagement message" }] }));
      await deliver(failed);
      await deliver(failed);
      const stored = (await messagesOf(w.courierConversation.id)).find((m) => m.waMessageId === ticket.wamid)!;
      assert.equal((stored.text.match(/No se pudo entregar por WhatsApp/g) ?? []).length, 1);
      assert.match(plain(stored.text), /No se pudo entregar por WhatsApp \(131047\)\.$/);
      assert.match(errorLog(), /mensaje no entregado/);
    });

    it("un cambio que trae acuses se atiende como acuse y no como mensaje (el bot no le responde a su propio acuse)", async () => {
      const { w, trip, ticket } = await ticketed();
      const payload = envelope({
        contacts: [{ wa_id: w.courier.phone, profile: { name: "Pedro P." } }],
        messages: [textMessage(w.courier.phone, "wamid.mixto", "ya recogí")],
        statuses: [status(ticket.wamid, "read", w.courier.phone)],
      });
      await deliver(payload);
      assert.ok((await getAssignment(trip.id)).readAt, "el acuse sí se atendió");
      assert.equal((await getAssignment(trip.id)).pickedUpAt, null, "el mensaje que venía en el mismo cambio no (Meta nunca los mezcla)");
      assert.deepEqual(await processedIds(), []);
      assert.equal((await getTrip(trip.id)).status, "en_route");
    });
  });
});
