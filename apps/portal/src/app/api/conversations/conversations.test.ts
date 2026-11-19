import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  bot,
  createConversation,
  createCourier,
  createRestaurant,
  createTrip,
  getConversation,
  installMocks,
  minutesAgo,
  params,
  request,
  resetMocks,
  restoreMocks,
} from "@/test-support/portal-env";
import { TAKEOVER_REASON } from "@/lib/chat";

/**
 * Conversaciones del portal: la bandeja (con los chats que piden ayuda
 * fijados arriba), el hilo, y lo que hace la central: intervenir un chat,
 * devolverlo al bot, escribir y responder la consulta de dirección del bot.
 * Las rutas se llaman tal cual, contra la base de pruebas; el bot (que es quien
 * manda el WhatsApp) es de mentiras. Sin `TEST_DATABASE_URL` se salta.
 */

type Conversations = typeof import("./route");
type Thread = typeof import("./[id]/route");
type NeedsHelp = typeof import("./needs-help/route");
let list: Conversations;
let thread: Thread;
let needsHelp: NeedsHelp;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  list = await import("./route");
  thread = await import("./[id]/route");
  needsHelp = await import("./needs-help/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

const act = (id: number, body: unknown) => thread.POST(request("POST", `/api/conversations/${id}`, { body }), params({ id }));
const message = (conversationId: number, role: "restaurant" | "bot" | "agent", text: string, over: Partial<typeof schema.messages.$inferInsert> = {}) =>
  db.insert(schema.messages).values({ conversationId, role, text, ...over }).returning().then((r) => r[0]);

type Row = { id: number; kind: string; courierName: string | null; restaurantName: string | null; photo: string | null; botPaused: boolean; escalationReason: string | null; lastText: string | null; lastRole: string | null; draft: unknown; advisorQuery: unknown };
const inbox = async () => (await (await list.GET()).json()) as Row[];

describe("conversaciones del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("GET /api/conversations: la bandeja", () => {
    it("cada chat con su último mensaje y quién lo dijo", async () => {
      const chat = await createConversation({ displayName: "Burgers" });
      await message(chat.id, "restaurant", "hola");
      await message(chat.id, "bot", "¡Hola! Envíame la dirección");
      const [row] = await inbox();
      assert.deepEqual([row.id, row.lastText, row.lastRole], [chat.id, "¡Hola! Envíame la dirección", "bot"]);
    });

    it("un chat sin mensajes sale sin último texto", async () => {
      await createConversation();
      const [row] = await inbox();
      assert.deepEqual([row.lastText, row.lastRole], [null, null]);
    });

    it("la vista previa no se pierde aunque otros chats tengan cientos de mensajes después (H1)", async () => {
      const quiet = await createConversation({ lastMessageAt: minutesAgo(120) });
      await message(quiet.id, "restaurant", "pedido de la mañana");
      const busy = await createConversation({ lastMessageAt: minutesAgo(1) });
      await db.insert(schema.messages).values(Array.from({ length: 600 }, (_, i) => ({ conversationId: busy.id, role: "bot" as const, text: `aviso ${i}` })));
      const rows = await inbox();
      assert.equal(rows.find((r) => r.id === quiet.id)?.lastText, "pedido de la mañana");
      assert.equal(rows.find((r) => r.id === busy.id)?.lastText, "aviso 599");
    });

    it("lo marca como motorizado si su número está en la flota activa, y como restaurante si no; con su nombre y foto del sistema", async () => {
      const courier = await createCourier({ name: "Pedro Gómez", photo: "data:image/jpeg;base64,AAAA" });
      const restaurant = await createRestaurant({ name: "Pizza Nona", photo: "data:image/jpeg;base64,BBBB" });
      const stranger = await createConversation({ displayName: "Alguien" });
      await createConversation({ phone: courier.phone, displayName: "Perfil de WhatsApp de Pedro" });
      await createConversation({ phone: restaurant.phone!, displayName: "Otro nombre en WhatsApp" });
      const rows = await inbox();
      const byName = Object.fromEntries(rows.map((r) => [r.courierName ?? r.restaurantName ?? "—", r]));
      assert.deepEqual([byName["Pedro Gómez"].kind, byName["Pedro Gómez"].restaurantName, byName["Pedro Gómez"].photo], ["courier", null, "data:image/jpeg;base64,AAAA"]);
      assert.deepEqual([byName["Pizza Nona"].kind, byName["Pizza Nona"].courierName, byName["Pizza Nona"].photo], ["restaurant", null, "data:image/jpeg;base64,BBBB"]);
      assert.equal(rows.find((r) => r.id === stranger.id)!.kind, "restaurant");
    });

    it("reconoce el número por sus últimos 10 dígitos (guardado a mano o como wa_id)", async () => {
      await createCourier({ name: "Pedro", phone: "3001234567" });
      await createConversation({ phone: "573001234567" });
      assert.equal((await inbox())[0].courierName, "Pedro");
    });

    it("un motorizado quitado de la flota (o un restaurante inactivo) vuelve a verse como un número cualquiera", async () => {
      const gone = await createCourier({ name: "Quitado", active: false });
      const closed = await createRestaurant({ name: "Cerrado", active: false });
      await createConversation({ phone: gone.phone });
      await createConversation({ phone: closed.phone! });
      for (const row of await inbox()) assert.deepEqual([row.kind, row.courierName, row.restaurantName], ["restaurant", null, null]);
    });

    it("arriba, fijados, los que piden ayuda; después los que atiende un asesor; después el resto, el más reciente primero", async () => {
      const recent = await createConversation({ lastMessageAt: minutesAgo(1) });
      const older = await createConversation({ lastMessageAt: minutesAgo(30) });
      const takenOver = await createConversation({ lastMessageAt: minutesAgo(10), botPaused: true, escalationReason: TAKEOVER_REASON });
      const helpOld = await createConversation({ lastMessageAt: minutesAgo(60), botPaused: true, escalationReason: "Consulta de dirección: x" });
      const helpNew = await createConversation({ lastMessageAt: minutesAgo(5), botPaused: true, escalationReason: "Novedad de Pedro: x" });
      const ids = (await inbox()).map((r) => r.id);
      assert.deepEqual(ids.slice(0, 2).sort(), [helpNew.id, helpOld.id].sort(), "los que piden ayuda");
      assert.equal(ids[2], takenOver.id, "luego el que atiende un asesor");
      assert.deepEqual(ids.slice(3), [recent.id, older.id], "y el resto por fecha");
    });

    it("un chat escalado donde ya respondió la central deja de pedir ayuda (y baja)", async () => {
      const answered = await createConversation({ lastMessageAt: minutesAgo(10), botPaused: true, escalationReason: "Consulta de dirección: x" });
      await message(answered.id, "bot", "Ya le paso tu pedido a la central");
      await message(answered.id, "agent", "Listo, ya lo reviso");
      const waiting = await createConversation({ lastMessageAt: minutesAgo(20), botPaused: true, escalationReason: "Consulta de dirección: y" });
      const ids = (await inbox()).map((r) => r.id);
      assert.equal(ids[0], waiting.id, "el que sigue esperando va primero");
    });

    it("resume el pedido a medio armar y las direcciones que el bot le preguntó a la central", async () => {
      await createConversation({
        draft: {
          etapa: "recibiendo",
          origenRestaurante: "Donde Lucho",
          entregas: [
            { direccionEntrega: "Calle 1", telefonoCliente: null, nombreCliente: null, valorACobrar: null, metodoPago: null, listoEnMinutos: null, notas: null, detalleDireccion: null, esConjunto: null },
            { direccionEntrega: "Carrera 83B #14A-121", detalleDireccion: "Torre 2", telefonoCliente: "3001112233", nombreCliente: "Marta", valorACobrar: 45_000, metodoPago: "efectivo", listoEnMinutos: 10, notas: null, esConjunto: null, barrio: "El Ingenio" },
          ],
          consultaAsesor: { entregas: [1], desde: new Date().toISOString() },
        } as never,
      });
      const [row] = await inbox();
      assert.deepEqual(row.draft, { origenRestaurante: "Donde Lucho", direccionEntrega: "Carrera 83B #14A-121", telefonoCliente: "3001112233", valorACobrar: 45_000, metodoPago: "efectivo" }, "la última entrega que va armando");
      assert.deepEqual(row.advisorQuery, [{ indice: 1, direccion: "Carrera 83B #14A-121 · Torre 2", barrio: "El Ingenio", cliente: "Marta", cobertura: null }]);
    });

    it("una consulta de cobertura trae la zona, los metros y el precio", async () => {
      await createConversation({
        draft: {
          etapa: "recibiendo",
          origenRestaurante: "Resto",
          entregas: [{ direccionEntrega: "Calle 10", telefonoCliente: null, nombreCliente: null, valorACobrar: null, metodoPago: null, listoEnMinutos: null, notas: null, detalleDireccion: null, esConjunto: null }],
          consultaAsesor: { entregas: [0], desde: new Date().toISOString(), motivo: "cobertura", cobertura: [{ indice: 0, zona: "Ciudad Jardín", metros: 120, precio: 8_000, km: 3.2, fuente: "calle" }] },
        } as never,
      });
      const [row] = await inbox();
      assert.deepEqual((row.advisorQuery as { cobertura: unknown }[])[0].cobertura, { zona: "Ciudad Jardín", metros: 120, precio: 8_000, km: 3.2, porCalle: true });
    });

    it("un borrador vacío no se muestra", async () => {
      await createConversation({ draft: { etapa: "recibiendo", origenRestaurante: null, entregas: [] } as never });
      const [row] = await inbox();
      assert.deepEqual([row.draft, row.advisorQuery], [null, null]);
    });

    it("trae como mucho los 100 chats más recientes", async () => {
      for (let i = 0; i < 105; i++) await createConversation({ lastMessageAt: new Date(Date.now() - i * 1000) });
      assert.equal((await inbox()).length, 100);
    });
  });

  describe("GET /api/conversations/needs-help", () => {
    it("cuántos chats piden ayuda y cuáles (la burbuja de la navegación y el timbre)", async () => {
      await createConversation();
      const help = await createConversation({ botPaused: true, escalationReason: "Novedad de Pedro: x" });
      await createConversation({ botPaused: true, escalationReason: TAKEOVER_REASON });
      const res = await needsHelp.GET();
      assert.deepEqual(await res.json(), { count: 1, ids: [help.id] });
    });

    it("sin chats que pidan ayuda: cero", async () => {
      await createConversation();
      assert.deepEqual(await (await needsHelp.GET()).json(), { count: 0, ids: [] });
    });

    it("cuando la central responde, deja de pedir ayuda; si el restaurante vuelve a escribir, la pide otra vez", async () => {
      const chat = await createConversation({ botPaused: true, escalationReason: "Novedad de Pedro: x" });
      await message(chat.id, "bot", "Recibido");
      assert.equal(((await (await needsHelp.GET()).json()) as { count: number }).count, 1);
      await message(chat.id, "agent", "Ya te escribo");
      assert.equal(((await (await needsHelp.GET()).json()) as { count: number }).count, 0);
      await message(chat.id, "restaurant", "¿y entonces?");
      assert.equal(((await (await needsHelp.GET()).json()) as { count: number }).count, 1);
    });

    it("lo que ve la bandeja y lo que cuenta la burbuja es lo mismo", async () => {
      await createConversation({ botPaused: true, escalationReason: "x" });
      const agent = await createConversation({ botPaused: true, escalationReason: "y" });
      await message(agent.id, "agent", "listo");
      const ids = ((await (await needsHelp.GET()).json()) as { ids: number[] }).ids;
      const pinned = (await inbox()).filter((r) => r.botPaused && r.escalationReason !== TAKEOVER_REASON && r.lastRole !== "agent").map((r) => r.id);
      assert.deepEqual(ids.sort(), pinned.sort());
    });
  });

  describe("GET /api/conversations/:id: el hilo", () => {
    const get = (id: number) => thread.GET(request("GET", `/api/conversations/${id}`), params({ id }));

    it("los mensajes en orden, con rol, hora y texto", async () => {
      const chat = await createConversation();
      await message(chat.id, "restaurant", "uno");
      await message(chat.id, "bot", "dos");
      await message(chat.id, "agent", "tres");
      const body = (await (await get(chat.id)).json()) as { role: string; text: string; createdAt: string }[];
      assert.deepEqual(body.map((m) => [m.role, m.text]), [["restaurant", "uno"], ["bot", "dos"], ["agent", "tres"]]);
      assert.ok(body.every((m) => !Number.isNaN(Date.parse(m.createdAt))));
    });

    it("un mensaje que cita otro lo trae, como en WhatsApp", async () => {
      const chat = await createConversation();
      const original = await message(chat.id, "bot", "Pedido A-01: va Pedro", { waMessageId: "wamid.1" });
      await message(chat.id, "restaurant", "gracias", { incoming: { kind: "text", text: "gracias", replyTo: "wamid.1" } });
      await message(chat.id, "bot", "de nada", { replyToWaMessageId: "wamid.1" });
      const body = (await (await get(chat.id)).json()) as { quote: { id: number; text: string } | null }[];
      assert.equal(body[0].quote, null);
      assert.deepEqual(body[1].quote, { id: original.id, role: "bot", text: "Pedido A-01: va Pedro" });
      assert.equal(body[2].quote?.id, original.id);
    });

    it("el mensaje con que el restaurante pidió lleva el código de los pedidos que salieron de él", async () => {
      const chat = await createConversation();
      await message(chat.id, "restaurant", "dos domis", { waMessageId: "wamid.pedido" });
      await message(chat.id, "bot", "Serían 2 domicilios");
      await createTrip({ conversationId: chat.id, code: "A-01", sourceWaMessageId: "wamid.pedido" });
      await createTrip({ conversationId: chat.id, code: "A-02", sourceWaMessageId: "wamid.pedido" });
      const body = (await (await get(chat.id)).json()) as { tripCodes: string[] }[];
      assert.deepEqual(body[0].tripCodes, ["A-01", "A-02"]);
      assert.deepEqual(body[1].tripCodes, [], "los avisos del bot ya dicen el código en el texto");
    });

    it("un chat sin mensajes o que no existe: lista vacía", async () => {
      const chat = await createConversation();
      assert.deepEqual(await (await get(chat.id)).json(), []);
      assert.deepEqual(await (await get(99_999)).json(), []);
    });

    it("no mezcla los mensajes de otros chats", async () => {
      const a = await createConversation();
      const b = await createConversation();
      await message(a.id, "restaurant", "de A");
      await message(b.id, "restaurant", "de B");
      assert.deepEqual(((await (await get(a.id)).json()) as { text: string }[]).map((m) => m.text), ["de A"]);
    });
  });

  describe("GET /api/conversations/:id?limit|before|after: el hilo por páginas (H2)", () => {
    type Page = { messages: { id: number; text: string; quote: { id: number } | null; tripCodes: string[] }[]; hasOlder: boolean | null; reset: boolean };
    const page = async (id: number, query: string) => {
      const res = await thread.GET(request("GET", `/api/conversations/${id}?${query}`), params({ id }));
      assert.equal(res.status, 200);
      return (await res.json()) as Page;
    };
    const fill = async (conversationId: number, n: number) =>
      db
        .insert(schema.messages)
        .values(Array.from({ length: n }, (_, i) => ({ conversationId, role: "bot" as const, text: `m${i + 1}` })))
        .returning({ id: schema.messages.id });

    it("al abrir: los últimos 50, en orden, y avisa que hay anteriores", async () => {
      const chat = await createConversation();
      await fill(chat.id, 120);
      const first = await page(chat.id, "limit=50");
      assert.equal(first.messages.length, 50);
      assert.equal(first.messages[0].text, "m71");
      assert.equal(first.messages[49].text, "m120");
      assert.equal(first.hasOlder, true);
      assert.equal(first.reset, false);
    });

    it("«Cargar anteriores» trae los de antes, hasta que no queda ninguno", async () => {
      const chat = await createConversation();
      await fill(chat.id, 70);
      const last = await page(chat.id, "limit=50");
      const older = await page(chat.id, `before=${last.messages[0].id}&limit=50`);
      assert.deepEqual([older.messages[0].text, older.messages.at(-1)?.text, older.messages.length], ["m1", "m20", 20]);
      assert.equal(older.hasOlder, false);
    });

    it("ponerse al día: solo lo posterior al id pedido, sin decir si hay anteriores", async () => {
      const chat = await createConversation();
      const ids = await fill(chat.id, 10);
      await message(chat.id, "restaurant", "nuevo");
      const fresh = await page(chat.id, `after=${ids[7].id}`);
      assert.deepEqual(fresh.messages.map((m) => m.text), ["m9", "m10", "nuevo"]);
      assert.equal(fresh.hasOlder, null);
    });

    it("con demasiados nuevos devuelve la última página entera (reset)", async () => {
      const chat = await createConversation();
      const ids = await fill(chat.id, 260);
      const fresh = await page(chat.id, `after=${ids[0].id}&limit=50`);
      assert.equal(fresh.reset, true);
      assert.equal(fresh.messages.length, 50);
      assert.equal(fresh.messages.at(-1)?.text, "m260");
      assert.equal(fresh.hasOlder, true);
    });

    it("una cita de un mensaje que no está en la página igual se muestra", async () => {
      const chat = await createConversation();
      const original = await message(chat.id, "bot", "Pedido A-01: va Pedro", { waMessageId: "wamid.viejo" });
      await fill(chat.id, 60);
      await message(chat.id, "restaurant", "¿ya salió?", { incoming: { kind: "text", text: "¿ya salió?", replyTo: "wamid.viejo" } });
      const last = await page(chat.id, "limit=10");
      assert.deepEqual(last.messages.at(-1)?.quote, { id: original.id, role: "bot", text: "Pedido A-01: va Pedro" });
    });

    it("el código del pedido sale en la página del mensaje que lo pidió, y no se mezclan chats", async () => {
      const chat = await createConversation();
      const other = await createConversation();
      await message(chat.id, "restaurant", "dos domis", { waMessageId: "wamid.pedido" });
      await createTrip({ conversationId: chat.id, code: "A-01", sourceWaMessageId: "wamid.pedido" });
      await message(other.id, "restaurant", "de otro chat");
      const p = await page(chat.id, "limit=50");
      assert.deepEqual(p.messages.map((m) => [m.text, m.tripCodes]), [["dos domis", ["A-01"]]]);
    });

    it("parámetros inválidos: 400", async () => {
      const chat = await createConversation();
      for (const query of ["limit=abc", "before=-1", "after=x", "before=5&after=2", "limit=0"]) {
        const res = await thread.GET(request("GET", `/api/conversations/${chat.id}?${query}`), params({ id: chat.id }));
        assert.equal(res.status, 400, query);
      }
    });
  });

  describe("POST /api/conversations/:id: lo que hace la central", () => {
    describe("intervenir (pause)", () => {
      it("el operador toma el chat: el bot se calla, con el motivo de siempre, y lo que el bot tenía a medias se descarta", async () => {
        const chat = await createConversation({ draft: { etapa: "recibiendo", origenRestaurante: "x", entregas: [] } as never, failedAttempts: 2 });
        const res = await act(chat.id, { action: "pause" });
        assert.deepEqual(await res.json(), { ok: true });
        const row = await getConversation(chat.id);
        assert.deepEqual([row.botPaused, row.escalationReason, row.draft, row.failedAttempts], [true, TAKEOVER_REASON, null, 0]);
      });

      it("un chat que la central tomó por su cuenta no cuenta como «pide ayuda»", async () => {
        const chat = await createConversation({ botPaused: true, escalationReason: "Consulta de dirección: x" });
        assert.equal(((await (await needsHelp.GET()).json()) as { count: number }).count, 1);
        await act(chat.id, { action: "pause" });
        assert.equal(((await (await needsHelp.GET()).json()) as { count: number }).count, 0);
      });

      it("no llama al bot (es un cambio de la base)", async () => {
        const chat = await createConversation();
        await act(chat.id, { action: "pause" });
        assert.equal(bot.calls.length, 0);
      });
    });

    describe("devolver al bot (resume)", () => {
      it("el bot vuelve a atender: sin pausa, sin motivo, sin borrador y sin intentos", async () => {
        const chat = await createConversation({ botPaused: true, escalationReason: TAKEOVER_REASON, draft: { etapa: "recibiendo", origenRestaurante: "x", entregas: [] } as never, failedAttempts: 2 });
        const res = await act(chat.id, { action: "resume" });
        assert.deepEqual(await res.json(), { ok: true });
        const row = await getConversation(chat.id);
        assert.deepEqual([row.botPaused, row.escalationReason, row.draft, row.failedAttempts], [false, null, null, 0]);
      });

      it("el chat que pedía ayuda se desfija", async () => {
        const chat = await createConversation({ botPaused: true, escalationReason: "Novedad de Pedro: x" });
        await act(chat.id, { action: "resume" });
        assert.equal(((await (await needsHelp.GET()).json()) as { count: number }).count, 0);
      });

      it("devolver y volver a intervenir es repetible", async () => {
        const chat = await createConversation();
        for (const action of ["pause", "resume", "pause", "resume"]) await act(chat.id, { action });
        assert.equal((await getConversation(chat.id)).botPaused, false);
      });
    });

    describe("escribir (send): sale por WhatsApp a través del bot", () => {
      it("le pide al bot que envíe el texto (recortado) en ese chat, con el secreto interno", async () => {
        const chat = await createConversation();
        const res = await act(chat.id, { action: "send", text: "  Ya voy para allá  " });
        assert.equal(res.status, 200);
        assert.deepEqual(bot.calls.map((c) => [c.path, c.body, c.secret]), [["/api/internal/send", { conversationId: chat.id, text: "Ya voy para allá" }, "secreto-interno-de-prueba"]]);
      });

      it("si el bot no pudo enviarlo (fuera de ventana, caído, secreto malo): 502 con el motivo", async () => {
        const chat = await createConversation();
        bot.reply({ status: 502, body: { reason: "outside_window" } });
        const res = await act(chat.id, { action: "send", text: "hola" });
        assert.equal(res.status, 502);
        assert.deepEqual(await res.json(), { ok: false, reason: "outside_window" });
        bot.reply({ status: 401, body: {} });
        assert.deepEqual(await (await act(chat.id, { action: "send", text: "hola" })).json(), { ok: false, reason: "bad_secret" });
        bot.reply("network");
        assert.equal((await act(chat.id, { action: "send", text: "hola" })).status, 502);
      });

      it("sin BOT_URL o INTERNAL_SECRET: 502 «no_bot», no se envía nada", async () => {
        const chat = await createConversation();
        delete process.env.BOT_URL;
        const res = await act(chat.id, { action: "send", text: "hola" });
        assert.equal(res.status, 502);
        assert.deepEqual(await res.json(), { ok: false, reason: "no_bot" });
        assert.equal(bot.calls.length, 0);
      });

      for (const text of ["", "   ", 5, null, undefined]) {
        it(`un texto vacío o que no es texto (${JSON.stringify(text)}): 400 y no llama al bot`, async () => {
          const chat = await createConversation();
          const res = await act(chat.id, { action: "send", text });
          assert.equal(res.status, 400);
          assert.equal(bot.calls.length, 0);
        });
      }
    });

    describe("responder la consulta de dirección del bot (address)", () => {
      it("le pasa al bot las respuestas de la central para que retome la conversación con el restaurante", async () => {
        const chat = await createConversation();
        const respuestas = [{ indice: 0, valida: true, precio: 8_000, direccion: "Carrera 83C #14A-121" }];
        const res = await act(chat.id, { action: "address", respuestas });
        assert.equal(res.status, 200);
        assert.deepEqual(bot.calls.map((c) => [c.path, c.body]), [["/api/internal/address", { conversationId: chat.id, respuestas }]]);
      });

      it("si el bot rechaza la respuesta (dirección inválida sin precio, sin consulta pendiente…): 502 con su motivo", async () => {
        const chat = await createConversation();
        bot.reply({ status: 409, body: { reason: "Esta conversación no tiene una consulta de dirección pendiente" } });
        const res = await act(chat.id, { action: "address", respuestas: [] });
        assert.equal(res.status, 502);
        assert.match(((await res.json()) as { reason: string }).reason, /no tiene una consulta/);
      });

      it("`respuestas` tiene que ser una lista: si no, es una acción inválida (400)", async () => {
        const chat = await createConversation();
        for (const respuestas of [undefined, null, "x", { indice: 0 }]) assert.equal((await act(chat.id, { action: "address", respuestas })).status, 400);
        assert.equal(bot.calls.length, 0);
      });
    });

    describe("acciones inválidas", () => {
      // `null` es JSON válido: antes la ruta hacía `body.action` sobre null y respondía 500 en vez de 400.
      for (const body of [{}, { action: "borrar" }, { action: 5 }, { text: "hola" }, null]) {
        it(`${JSON.stringify(body)}: 400 «Acción inválida» y no cambia nada`, async () => {
          const chat = await createConversation({ botPaused: true, escalationReason: "x" });
          const res = await act(chat.id, body);
          assert.equal(res.status, 400);
          assert.deepEqual(await res.json(), { error: "Acción inválida" });
          assert.equal((await getConversation(chat.id)).escalationReason, "x");
          assert.equal(bot.calls.length, 0);
        });
      }

      it("un cuerpo que no es JSON: 400, no un error del servidor", async () => {
        const chat = await createConversation();
        const res = await thread.POST(request("POST", `/api/conversations/${chat.id}`, { raw: "no es json" }), params({ id: chat.id }));
        assert.equal(res.status, 400);
      });
    });

    it("pausar o devolver un chat que no existe no falla ni crea nada", async () => {
      assert.equal((await act(99_999, { action: "pause" })).status, 200);
      assert.equal((await act(99_999, { action: "resume" })).status, 200);
      assert.equal((await db.select().from(schema.conversations).where(eq(schema.conversations.id, 99_999))).length, 0);
    });
  });
});
