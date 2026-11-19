import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * Las alertas al celular contra un Postgres de verdad: qué avisa `runPushAlerts`
 * y qué no. Mismas reglas que `trip-lifecycle.integration.test.ts`: solo corren
 * con `TEST_DATABASE_URL` (una base ya migrada, de usar y tirar: se vacían sus
 * tablas); sin ella se saltan. Los archivos de integración comparten esa base:
 * córrelos en serie (`tsx --test --test-concurrency=1`).
 */
const url = process.env.TEST_DATABASE_URL;
const skip = !url ? "falta TEST_DATABASE_URL" : false;

if (url) {
  if (!/\/[^/?]*test[^/?]*(\?|$)/i.test(url)) throw new Error("TEST_DATABASE_URL tiene que apuntar a una base cuyo nombre contenga «test»");
  process.env.DATABASE_URL = url;
}
// El disco de la máquina de pruebas no es el del servidor (ver db/test-db.ts).
process.env.DISK_ALERTS ??= "off";

type Push = typeof import("./push");
type Client = typeof import("./client");
type Schema = typeof import("./schema");

const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

describe("alertas al celular (Postgres)", { skip }, () => {
  let push: Push;
  let client: Client;
  let schema: Schema;
  let seq = 0;

  before(async () => {
    push = await import("./push");
    client = await import("./client");
    schema = await import("./schema");
  });

  after(async () => {
    await (client.db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
  });

  beforeEach(async () => {
    const { db } = client;
    await db.delete(schema.pushAlertState);
    await db.delete(schema.settings);
    await db.delete(schema.returnDebtClaims);
    await db.delete(schema.returnDebts);
    await db.delete(schema.assignments);
    await db.delete(schema.trips);
    await db.delete(schema.couriers);
    await db.delete(schema.messages);
    await db.delete(schema.conversations);
  });

  async function courier(status: "available" | "busy" | "paused" = "busy", phone = `57310${String(++seq).padStart(7, "0")}`) {
    const [c] = await client.db.insert(schema.couriers).values({ name: `Moto ${seq}`, phone, status }).returning();
    return c;
  }

  /** Un viaje con moto; `assignment` y `trip` pisan lo que haga falta. */
  async function trip(
    c: { id: number; name: string },
    assignment: Partial<typeof schema.assignments.$inferInsert> = {},
    status: "pending" | "assigned" | "en_route" = "en_route",
    fields: Partial<typeof schema.trips.$inferInsert> = {},
  ) {
    const [t] = await client.db
      .insert(schema.trips)
      .values({ code: `T${++seq}`, originRestaurantName: "Donde Lucho", deliveryAddress: "Calle 5 # 40-12", status, ...fields })
      .returning();
    if (status !== "pending") {
      await client.db.insert(schema.assignments).values({ tripId: t.id, courierId: c.id, courierName: c.name, assignedAt: ago(1), ...assignment });
    }
    return t;
  }

  async function chat(phone: string, opts: { reason?: string; messages?: { role: "restaurant" | "bot" | "agent"; minutesAgo: number }[]; paused?: boolean; lastMessageMinutesAgo?: number } = {}) {
    const msgs = opts.messages ?? [{ role: "restaurant", minutesAgo: 1 }];
    const last = Math.min(...msgs.map((m) => m.minutesAgo), opts.lastMessageMinutesAgo ?? Infinity);
    const [conv] = await client.db
      .insert(schema.conversations)
      .values({ phone, botPaused: opts.paused ?? true, escalationReason: opts.reason ?? "Pidió hablar con una persona.", lastMessageAt: ago(last) })
      .returning();
    for (const m of msgs) {
      await client.db.insert(schema.messages).values({ conversationId: conv.id, role: m.role, text: "mensaje", createdAt: ago(m.minutesAgo) });
    }
    return conv;
  }

  const run = async () => (await push.runPushAlerts()).map((m) => ({ tag: m.tag, severity: m.severity, title: m.title, url: m.url }));

  describe("lo que NO avisa (ruido operativo)", () => {
    it("una moto asignada, aunque sea nueva", async () => {
      const c = await courier();
      await trip(c, { assignedAt: ago(1) }, "assigned");
      await trip(c, { assignedAt: ago(1) }, "en_route");
      assert.deepEqual(await run(), []);
    });

    it("un pedido pendiente hace más de 2 minutos sin moto", async () => {
      await trip({ id: 0, name: "-" }, {}, "pending", { createdAt: ago(30) });
      assert.deepEqual(await run(), []);
    });

    it("una moto que no confirma «Voy en camino» (seenAlertMinutes)", async () => {
      const c = await courier();
      // Asignada hace 8 min (más que seenAlertMinutes = 6) pero aún dentro de pickupLateMinutes (10).
      await trip(c, { assignedAt: ago(8), readAt: ago(7) }, "assigned");
      assert.deepEqual(await run(), []);
    });

    it("una moto que salió del punto de entrega sin marcar entrega (leftDeliveryAt)", async () => {
      const c = await courier();
      await trip(c, { assignedAt: ago(15), seenAt: ago(14), pickedUpAt: ago(10), atDeliveryAt: ago(3), leftDeliveryAt: ago(1) });
      assert.deepEqual(await run(), []);
    });
  });

  describe("🔴 rojo: bloqueos graves", () => {
    it("la moto no recoge: pasó pickupLateMinutes desde la asignación", async () => {
      const c = await courier();
      const t = await trip(c, { assignedAt: ago(11) });
      const alerts = await run();
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].severity, "critical");
      assert.match(alerts[0].title, /^🚨 Moto no recoge/);
      assert.equal(alerts[0].url, `/viajes#pedido=${t.id}`);
    });

    it("con hora de listo en el futuro, la demora cuenta desde esa hora", async () => {
      const c = await courier();
      await trip(c, { assignedAt: ago(11) }, "en_route", { readyAt: new Date(Date.now() + 20 * MIN) });
      assert.deepEqual(await run(), []);
    });

    it("entrega estancada: más de deliveryAlertMinutes desde que recogió", async () => {
      const c = await courier();
      const t = await trip(c, { assignedAt: ago(45), pickedUpAt: ago(31) });
      const alerts = await run();
      assert.deepEqual(alerts.map((a) => [a.severity, a.url]), [["critical", `/viajes#pedido=${t.id}`]]);
      assert.match(alerts[0].title, /Entrega estancada/);
    });

    it("una entrega que lleva 29 minutos todavía no avisa", async () => {
      const c = await courier();
      await trip(c, { assignedAt: ago(45), pickedUpAt: ago(29) });
      assert.deepEqual(await run(), []);
    });

    it("devolución estancada: más de returnAlertMinutes sin «Devolví el pedido»", async () => {
      const c = await courier();
      await trip(c, { assignedAt: ago(70), pickedUpAt: ago(60), customerWaitAt: ago(40), undeliveredAt: ago(21) });
      const alerts = await run();
      // Ya no es «cliente no contesta» (naranja): es la devolución estancada.
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].severity, "critical");
      assert.match(alerts[0].title, /Devolución estancada/);
    });

    it("el aviso sale una sola vez, no en cada tick", async () => {
      const c = await courier();
      await trip(c, { assignedAt: ago(11) });
      assert.equal((await run()).length, 1);
      assert.deepEqual(await run(), []);
    });

    it("una moto en pausa en Flota es una emergencia", async () => {
      const c = await courier("paused");
      const alerts = await run();
      assert.deepEqual(alerts.map((a) => [a.severity, a.url]), [["critical", "/flota"]]);
      assert.match(alerts[0].title, new RegExp(`^🚨 Emergencia · ${c.name}`));
    });

    it("novedad reportada por el chat del motorizado: un solo aviso rojo, el del chat", async () => {
      const c = await courier("paused", "573101112233");
      await chat("573101112233", { reason: `Novedad de ${c.name}: se accidentó` });
      const alerts = await run();
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].severity, "critical");
      assert.match(alerts[0].url, /^\/conversaciones#tel=/);
    });
  });

  describe("🟠 naranja: requiere atención", () => {
    it("cliente que no contesta: avisa apenas el domiciliario lo reporta", async () => {
      const c = await courier();
      const t = await trip(c, { assignedAt: ago(15), seenAt: ago(14), pickedUpAt: ago(8), customerWaitAt: ago(1) });
      const alerts = await run();
      assert.deepEqual(alerts.map((a) => [a.severity, a.url]), [["attention", `/viajes#pedido=${t.id}`]]);
      assert.match(alerts[0].title, /^⚠️ Cliente no contesta/);
    });

    it("el chat de un restaurante que pide ayuda es naranja", async () => {
      await chat("573001112233", { reason: "El restaurante dio datos confusos o pidió hablar con una persona." });
      const alerts = await run();
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].severity, "attention");
      assert.match(alerts[0].title, /^⚠️ .* pide ayuda$/);
    });

    it("el chat de un motorizado que pide ayuda es rojo", async () => {
      await courier("busy", "573101112233");
      await chat("573101112233", { reason: "Novedad de Moto: se varó" });
      const alerts = await run();
      assert.equal(alerts[0].severity, "critical");
      assert.match(alerts[0].title, /^🚨 /);
    });
  });

  describe("chat_help: enfriamiento tras la central", () => {
    it("«ok gracias» a los 2 min de que el operador escribió no avisa", async () => {
      await chat("573001112233", {
        messages: [
          { role: "restaurant", minutesAgo: 8 },
          { role: "agent", minutesAgo: 3 },
          { role: "restaurant", minutesAgo: 1 },
        ],
      });
      assert.deepEqual(await run(), []);
      // Ni cuando pasan los 5 min: ese mensaje ya quedó sin avisar.
      await client.db.update(schema.conversations).set({ lastMessageAt: ago(1) });
      assert.deepEqual(await run(), []);
    });

    it("un mensaje nuevo pasado el enfriamiento sí avisa", async () => {
      await chat("573001112233", {
        messages: [
          { role: "agent", minutesAgo: 9 },
          { role: "restaurant", minutesAgo: 2 },
        ],
      });
      assert.equal((await run()).length, 1);
    });

    it("un chat que la central nunca atendió avisa de una vez", async () => {
      await chat("573001112233", { messages: [{ role: "restaurant", minutesAgo: 1 }] });
      assert.equal((await run()).length, 1);
    });

    it("el portal (burbuja) sigue contando ese chat aunque el celular no avise", async () => {
      const conv = await chat("573001112233", {
        messages: [
          { role: "agent", minutesAgo: 3 },
          { role: "restaurant", minutesAgo: 1 },
        ],
      });
      const { and, eq } = await import("drizzle-orm");
      const rows = await client.db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(and(eq(schema.conversations.id, conv.id), push.needsHelpCondition()));
      assert.equal(rows.length, 1);
      assert.deepEqual(await run(), []);
    });
  });

  describe("datáfonos y reclamos siguen avisando (naranja)", () => {
    const clock = (offsetMinutes: number) => {
      const caliMinutes = (((Math.floor(Date.now() / MIN) - 300 + offsetMinutes) % 1440) + 1440) % 1440;
      return `${String(Math.floor(caliMinutes / 60)).padStart(2, "0")}:${String(caliMinutes % 60).padStart(2, "0")}`;
    };

    it("un reclamo de plata sin resolver", async () => {
      await client.db.insert(schema.returnDebtClaims).values({ restaurantName: "Donde Lucho", reason: "plata", why: "Dice que le deben la plata de ayer." });
      const alerts = await run();
      assert.deepEqual(alerts.map((a) => [a.severity, a.url]), [["attention", "/pendientes"]]);
      assert.match(alerts[0].title, /^⚠️ Reclamo de plata · Donde Lucho/);
    });

    it("un reclamo ya atendido no avisa", async () => {
      await client.db.insert(schema.returnDebtClaims).values({ restaurantName: "Donde Lucho", reason: "plata", why: "x", handledAt: new Date() });
      assert.deepEqual(await run(), []);
    });

    it("un datáfono afuera más de datafonoAlertMinutes", async () => {
      const c = await courier("available");
      await client.db.insert(schema.returnDebts).values({ courierId: c.id, restaurantName: "Donde Lucho", reason: "datafono", declaredBy: "central", createdAt: ago(31) });
      const alerts = await run();
      assert.deepEqual(alerts.map((a) => [a.severity, a.url]), [["attention", "/pendientes"]]);
      assert.match(alerts[0].title, /^⚠️ Datáfono sin devolver · Donde Lucho/);
    });

    it("un datáfono de hace 10 minutos todavía no", async () => {
      const c = await courier("available");
      await client.db.insert(schema.returnDebts).values({ courierId: c.id, restaurantName: "Donde Lucho", reason: "datafono", declaredBy: "central", createdAt: ago(10) });
      assert.deepEqual(await run(), []);
    });

    it("un datáfono que sigue afuera al cierre del restaurante", async () => {
      const c = await courier("available");
      // Ahora mismo el restaurante está cerrado: abre en 1 h y cierra en 2 h.
      await client.db.insert(schema.settings).values({ key: "service_hours", value: { opensAt: clock(60), defaultDeadline: clock(120) } });
      await client.db.insert(schema.returnDebts).values({ courierId: c.id, restaurantName: "Donde Lucho", reason: "datafono", declaredBy: "central", createdAt: ago(5) });
      const alerts = await run();
      assert.ok(alerts.some((a) => a.severity === "attention" && /^⚠️ Datáfono afuera al cierre/.test(a.title)), JSON.stringify(alerts));
    });
  });
});
