import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, declareReturnDebt, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  assignedTrip,
  bot,
  createConversation,
  createCourier,
  createTrip,
  getAssignment,
  getConversation,
  getCourier,
  getTrip,
  installMocks,
  minutesAgo,
  params,
  request,
  resetMocks,
  restoreMocks,
  setAssignment,
} from "@/test-support/portal-env";

/**
 * Flota desde el portal: la lista, dar de alta, ponerlos en emergencia (que
 * pausa su chat), conectarlos o desconectarlos (devolviendo solo lo que no
 * han recogido), su ficha y el identificador de GPS. Las rutas se llaman tal
 * cual, contra la base de pruebas; el bot es de mentiras. La protección con
 * sesión está en `proxy.test.ts`. Sin `TEST_DATABASE_URL` se salta.
 */

type Couriers = typeof import("./route");
type CourierById = typeof import("./[id]/route");
type Profile = typeof import("./[id]/profile/route");
type Gps = typeof import("./[id]/gps/route");
let couriers: Couriers;
let byId: CourierById;
let profile: Profile;
let gps: Gps;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  couriers = await import("./route");
  byId = await import("./[id]/route");
  profile = await import("./[id]/profile/route");
  gps = await import("./[id]/gps/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

const patch = (id: number, body: unknown) => byId.PATCH(request("PATCH", `/api/couriers/${id}`, { body }), params({ id }));
const notifications = () => bot.calls.filter((c) => c.path === "/api/internal/notify");
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("flota del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("GET /api/couriers", () => {
    type Row = { id: number; name: string; status: string; assignable: boolean; hasGps: boolean; seenStats: { confirmed: number; reminders: number; avgMinutes: number | null } | null; returnDebts: { datafono: number; plata: number } | null; route: { kind: string; text: string }[]; simulator: unknown };
    const list = async () => (await (await couriers.GET()).json()) as Row[];

    it("lista solo a los activos, el más nuevo primero", async () => {
      const first = await createCourier({ name: "Pedro" });
      await new Promise((r) => setTimeout(r, 15));
      const second = await createCourier({ name: "Luis" });
      await createCourier({ name: "Quitado", active: false });
      assert.deepEqual((await list()).map((c) => c.id), [second.id, first.id]);
    });

    it("dice a quién se le puede asignar (con el simulador apagado, a las motos reales) y que no hay modo simulador", async () => {
      await createCourier({ name: "Real" });
      await createCourier({ name: "Simulada", simulated: true });
      const rows = await list();
      assert.equal(rows.find((c) => c.name === "Real")!.assignable, true);
      assert.equal(rows.find((c) => c.name === "Simulada")!.assignable, false);
      assert.ok(rows.every((c) => c.simulator === null));
    });

    it("marca las que ya tienen identificador de GPS", async () => {
      const withGps = await createCourier({ name: "Con GPS" });
      await createCourier({ name: "Sin GPS" });
      await db.insert(schema.courierProfiles).values({ courierId: withGps.id, gpsDeviceId: "moto-abc" });
      const rows = await list();
      assert.equal(rows.find((c) => c.name === "Con GPS")!.hasGps, true);
      assert.equal(rows.find((c) => c.name === "Sin GPS")!.hasGps, false);
    });

    it("cuánto tarda en tocar «Voy en camino» y cuántas veces hubo que recordárselo (últimos 7 días)", async () => {
      const courier = await createCourier({ name: "Pedro", status: "available" });
      const a = await assignedTrip(courier.id);
      const b = await assignedTrip(courier.id);
      const old = await assignedTrip(courier.id);
      const t0 = minutesAgo(30);
      await setAssignment(a.id, { assignedAt: t0, seenAt: new Date(t0.getTime() + 2 * 60_000) });
      await setAssignment(b.id, { assignedAt: t0, seenAt: new Date(t0.getTime() + 4 * 60_000), seenReminderAt: new Date(t0.getTime() + 3 * 60_000) });
      await setAssignment(old.id, { assignedAt: new Date(Date.now() - 9 * 86400_000), seenAt: new Date(Date.now() - 9 * 86400_000 + 60_000) });
      const row = (await list())[0];
      assert.deepEqual(row.seenStats, { confirmed: 2, reminders: 1, avgMinutes: 3 }, "lo de hace 9 días no cuenta");
    });

    it("sin actividad reciente no hay estadística", async () => {
      await createCourier();
      assert.equal((await list())[0].seenStats, null);
    });

    it("sus pendientes de regreso abiertos por motivo, y su ruta en orden", async () => {
      const courier = await createCourier({ status: "available" });
      const trip = await assignedTrip(courier.id);
      await declareReturnDebt({ courierId: courier.id, reason: "datafono", restaurantName: "Resto", tripId: trip.id, declaredBy: "courier" });
      const row = (await list())[0];
      assert.deepEqual(row.returnDebts, { datafono: 1, plata: 0 });
      assert.match(row.route.map((s) => s.text).join(" | "), new RegExp(`Recoge ${trip.code}.*Entrega ${trip.code}`));
    });

    it("una moto desconectada no arma ruta", async () => {
      const courier = await createCourier({ status: "available" });
      await assignedTrip(courier.id);
      await db.update(schema.couriers).set({ status: "offline" }).where(eq(schema.couriers.id, courier.id));
      assert.deepEqual((await list())[0].route, []);
    });
  });

  describe("POST /api/couriers (dar de alta)", () => {
    const create = (body: unknown) => couriers.POST(request("POST", "/api/couriers", { body }));

    it("crea al motorizado desconectado (se conecta al escribir por primera vez) con su turno empezado", async () => {
      const res = await create({ name: "  Pedro Gómez ", phone: "300 123 4567" });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { id: number; name: string; status: string; phone: string; active: boolean };
      assert.deepEqual([body.name, body.status, body.active], ["Pedro Gómez", "offline", true]);
      const row = await getCourier(body.id);
      assert.ok(row.shiftStartedAt);
      assert.equal(row.locationUpdatedAt, null);
    });

    it("el teléfono queda como lo identifica WhatsApp (57 + 10 dígitos) para que el bot lo reconozca", async () => {
      for (const [written, stored] of [
        ["300 123 4567", "573001234567"],
        ["3001234567", "573001234567"],
        ["573001234567", "573001234567"],
        ["+57 300-123-4567", "573001234567"],
        ["(300) 123 4567", "573001234567"],
      ]) {
        const res = await create({ name: "Moto", phone: written });
        assert.equal(((await res.json()) as { phone: string }).phone, stored, written);
        await resetDatabase();
      }
    });

    it("con ubicación inicial guarda la posición y la hora", async () => {
      const res = await create({ name: "Moto", phone: "3001234567", lat: 3.45, lng: -76.53 });
      const row = await getCourier(((await res.json()) as { id: number }).id);
      assert.deepEqual([row.lat, row.lng], [3.45, -76.53]);
      assert.ok(row.locationUpdatedAt && Date.now() - row.locationUpdatedAt.getTime() < 5_000);
    });

    it("una latitud o longitud que no es número se ignora", async () => {
      const res = await create({ name: "Moto", phone: "3001234567", lat: "3.45", lng: null });
      const row = await getCourier(((await res.json()) as { id: number }).id);
      assert.deepEqual([row.lat, row.lng, row.locationUpdatedAt], [null, null, null]);
    });

    it("un número que la central quitó de la flota vuelve con su misma ficha, y su chat pidiendo volver regresa al bot", async () => {
      const former = await createCourier({ name: "Lauri", phone: "573001234567", active: false, status: "offline", deliveriesThisShift: 4 });
      await createConversation({ phone: "573001234567", botPaused: true, escalationReason: "Quitado de la flota: Lauri pide volver." });
      const res = await create({ name: "Lauri Gómez", phone: "300 123 4567" });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { id: number };
      assert.equal(body.id, former.id, "la misma ficha, con su historial");
      const row = await getCourier(former.id);
      assert.deepEqual([row.name, row.active, row.status, row.deliveriesThisShift], ["Lauri Gómez", true, "offline", 0]);
      assert.equal((await db.select().from(schema.couriers)).length, 1);
      const [chat] = await db.select().from(schema.conversations).where(eq(schema.conversations.phone, "573001234567"));
      assert.deepEqual([chat.botPaused, chat.escalationReason], [false, null]);
    });

    it("al volver no le suelta a la central un chat que tiene por otro motivo", async () => {
      await createCourier({ phone: "573001234567", active: false, status: "offline" });
      await createConversation({ phone: "573001234567", botPaused: true, escalationReason: "Lo atiende la central." });
      await create({ name: "Lauri", phone: "3001234567" });
      const [chat] = await db.select().from(schema.conversations).where(eq(schema.conversations.phone, "573001234567"));
      assert.equal(chat.botPaused, true);
    });

    it("una moto simulada quitada no se reactiva: se crea otra", async () => {
      const sim = await createCourier({ phone: "573001234567", active: false, simulated: true });
      const body = (await (await create({ name: "Real", phone: "3001234567" })).json()) as { id: number };
      assert.notEqual(body.id, sim.id);
    });

    for (const [name, body] of [
      ["sin nombre", { phone: "3001234567" }],
      ["sin teléfono", { name: "Pedro" }],
      ["con el nombre en blanco", { name: "   ", phone: "3001234567" }],
      ["con el teléfono en blanco", { name: "Pedro", phone: "  " }],
      ["con tipos que no son texto", { name: 5, phone: ["3"] }],
    ] as const) {
      it(`${name}: 400 «Falta nombre o teléfono» y no crea nada`, async () => {
        const res = await create(body);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Falta nombre o teléfono" });
        assert.equal((await db.select().from(schema.couriers)).length, 0);
      });
    }
  });

  describe("PATCH /api/couriers/:id", () => {
    describe("quitar de la flota", () => {
      it("la deja inactiva y desconectada (su nombre sigue en el arqueo)", async () => {
        const courier = await createCourier({ status: "available" });
        const res = await patch(courier.id, { active: false });
        assert.deepEqual(await res.json(), { ok: true });
        const row = await getCourier(courier.id);
        assert.deepEqual([row.active, row.status], [false, "offline"]);
      });

      it("le pide al bot que le avise, una sola vez", async () => {
        const courier = await createCourier({ status: "available" });
        await patch(courier.id, { active: false });
        await patch(courier.id, { active: false });
        assert.deepEqual(
          notifications().map((c) => c.body),
          [{ removedCourier: courier.id }],
        );
      });

      it("un motorizado en un viaje (ocupado) no se puede quitar, y no se le avisa nada", async () => {
        const courier = await createCourier({ status: "available" });
        await assignedTrip(courier.id);
        await patch(courier.id, { active: false });
        const row = await getCourier(courier.id);
        assert.deepEqual([row.active, row.status], [true, "busy"]);
        assert.equal(notifications().length, 0);
      });
    });

    describe("foto", () => {
      it("guarda un JPEG pequeño y se puede quitar con null", async () => {
        const courier = await createCourier();
        const res = await patch(courier.id, { photo: JPEG });
        assert.equal(res.status, 200);
        assert.equal((await getCourier(courier.id)).photo, JPEG);
        assert.equal((await patch(courier.id, { photo: null })).status, 200);
        assert.equal((await getCourier(courier.id)).photo, null);
      });

      it("rechaza lo que no es un JPEG en data URL, o es demasiado grande: 400 «Foto inválida»", async () => {
        const courier = await createCourier();
        for (const photo of ["data:image/png;base64,AAAA", "https://x.test/a.jpg", 5, "", `data:image/jpeg;base64,${"A".repeat(200_000)}`]) {
          const res = await patch(courier.id, { photo });
          assert.equal(res.status, 400, String(photo).slice(0, 30));
          assert.deepEqual(await res.json(), { error: "Foto inválida" });
        }
        assert.equal((await getCourier(courier.id)).photo, null);
      });

      it("de un motorizado que no existe: 404", async () => {
        assert.equal((await patch(99_999, { photo: JPEG })).status, 404);
      });
    });

    describe("admin con prioridad en la asignación (#120)", () => {
      it("se marca y se desmarca, y se ve en la lista", async () => {
        const courier = await createCourier({ status: "available" });
        assert.equal((await getCourier(courier.id)).isAdmin, false, "por defecto no es admin");
        const res = await patch(courier.id, { isAdmin: true });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).isAdmin, true);
        assert.equal((await getCourier(courier.id)).isAdmin, true);
        const list = (await (await couriers.GET()).json()) as { id: number; isAdmin: boolean }[];
        assert.equal(list.find((c) => c.id === courier.id)?.isAdmin, true);
        assert.equal((await patch(courier.id, { isAdmin: false })).status, 200);
        assert.equal((await getCourier(courier.id)).isAdmin, false);
      });

      it("no le cambia el estado ni avisa al bot", async () => {
        const courier = await createCourier({ status: "available" });
        const before = bot.calls.length;
        await patch(courier.id, { isAdmin: true });
        assert.equal((await getCourier(courier.id)).status, "available");
        assert.equal(bot.calls.length, before);
      });

      it("un valor que no es true o false: 400 y no cambia nada", async () => {
        const courier = await createCourier();
        for (const isAdmin of ["true", 1, null]) {
          const res = await patch(courier.id, { isAdmin });
          assert.equal(res.status, 400, String(isAdmin));
        }
        assert.equal((await getCourier(courier.id)).isAdmin, false);
      });

      it("de un motorizado que no existe: 404", async () => {
        assert.equal((await patch(99_999, { isAdmin: true })).status, 404);
      });
    });

    describe("emergencia (rojo): un accidente, una moto varada", () => {
      it("pausa a la moto y deja su chat en manos de la central, con el motivo", async () => {
        const courier = await createCourier({ name: "Pedro Gómez", status: "available" });
        const conversation = await createConversation({ phone: courier.phone, draft: { etapa: "recibiendo" } as never, failedAttempts: 2 });
        const res = await patch(courier.id, { emergency: true });
        assert.equal(res.status, 200);
        assert.equal((await getCourier(courier.id)).status, "paused");
        const chat = await getConversation(conversation.id);
        assert.equal(chat.botPaused, true);
        assert.equal(chat.escalationReason, "Emergencia marcada desde Flota. Pedro Gómez");
      });

      it("si nunca había escrito, se le abre un chat", async () => {
        const courier = await createCourier({ name: "Pedro Gómez", status: "available" });
        assert.equal((await db.select().from(schema.conversations)).length, 0);
        await patch(courier.id, { emergency: true });
        const [chat] = await db.select().from(schema.conversations);
        assert.deepEqual([chat.phone, chat.displayName, chat.botPaused], [courier.phone, "Pedro Gómez", true]);
      });

      it("lo que lleva sigue a su nombre para que la central decida", async () => {
        const courier = await createCourier({ status: "available" });
        const trip = await assignedTrip(courier.id);
        await patch(courier.id, { emergency: true });
        assert.equal((await getAssignment(trip.id)).courierId, courier.id);
        assert.equal((await getTrip(trip.id)).status, "en_route");
      });

      it("el chat queda fijado arriba (pide ayuda) y suena en el celular de la central", async () => {
        const courier = await createCourier({ status: "available" });
        await patch(courier.id, { emergency: true });
        const { idsNeedingHelp } = await import("@/db/queries/conversations");
        const [chat] = await db.select().from(schema.conversations);
        assert.deepEqual(await idsNeedingHelp(), [chat.id]);
      });

      it("al quitarla vuelve el bot: el chat se destraba y la moto queda libre", async () => {
        const courier = await createCourier({ status: "available" });
        await patch(courier.id, { emergency: true });
        await patch(courier.id, { emergency: false });
        assert.equal((await getCourier(courier.id)).status, "available");
        const [chat] = await db.select().from(schema.conversations);
        assert.deepEqual([chat.botPaused, chat.escalationReason], [false, null]);
      });

      it("al quitarla, la moto que todavía lleva un pedido queda ocupada, no libre", async () => {
        const courier = await createCourier({ status: "available" });
        await assignedTrip(courier.id);
        await patch(courier.id, { emergency: true });
        await patch(courier.id, { emergency: false });
        assert.equal((await getCourier(courier.id)).status, "busy");
      });

      it("al quitarla se limpia el pedido que el bot tenía a medias y sus intentos", async () => {
        const courier = await createCourier({ status: "available" });
        const conversation = await createConversation({ phone: courier.phone, draft: { etapa: "recibiendo" } as never, failedAttempts: 2, botPaused: true, escalationReason: "x" });
        await patch(courier.id, { emergency: false });
        const chat = await getConversation(conversation.id);
        assert.deepEqual([chat.draft, chat.failedAttempts, chat.botPaused], [null, 0, false]);
      });

      it("de un motorizado que no existe: 404", async () => {
        assert.equal((await patch(99_999, { emergency: true })).status, 404);
        assert.equal((await db.select().from(schema.conversations)).length, 0);
      });

      it("la emergencia solo se pone y se quita con `emergency`: por `status: paused` es 400, para que siempre vaya con su chat", async () => {
        const courier = await createCourier({ status: "available" });
        const res = await patch(courier.id, { status: "paused" });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Usa emergency" });
        assert.equal((await getCourier(courier.id)).status, "available");
      });
    });

    describe("conectar y desconectar", () => {
      it("desconectar devuelve solo lo que no ha recogido, avisa al bot y deja lo que ya lleva", async () => {
        const courier = await createCourier({ status: "available" });
        const waiting = await assignedTrip(courier.id);
        const carrying = await assignedTrip(courier.id);
        await setAssignment(carrying.id, { seenAt: minutesAgo(5), pickedUpAt: minutesAgo(2) });
        const res = await patch(courier.id, { status: "offline" });
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as { status: string }).status, "offline");
        assert.equal((await getTrip(waiting.id)).status, "pending", "el no recogido vuelve a despacho");
        assert.equal(await getAssignment(waiting.id), undefined);
        assert.equal((await getTrip(carrying.id)).status, "en_route", "el recogido sigue con ella");
        assert.equal((await getAssignment(carrying.id)).courierId, courier.id);
        assert.deepEqual(notifications().map((c) => c.body), [{ unassigned: [{ tripId: waiting.id, courierId: courier.id }] }]);
      });

      it("sin nada que devolver no llama al bot", async () => {
        const courier = await createCourier({ status: "available" });
        await patch(courier.id, { status: "offline" });
        assert.equal(bot.calls.length, 0);
      });

      it("el turno que se le había contado por los pedidos devueltos se le devuelve", async () => {
        const courier = await createCourier({ status: "available" });
        await assignedTrip(courier.id);
        assert.equal((await getCourier(courier.id)).deliveriesThisShift, 1);
        await patch(courier.id, { status: "offline" });
        assert.equal((await getCourier(courier.id)).deliveriesThisShift, 0);
      });

      it("conectar sin pedidos la deja libre; conectar llevando un pedido la deja ocupada", async () => {
        const free = await createCourier({ status: "offline" });
        await patch(free.id, { status: "available" });
        assert.equal((await getCourier(free.id)).status, "available");
        const loaded = await createCourier({ status: "available" });
        await assignedTrip(loaded.id);
        await db.update(schema.couriers).set({ status: "offline" }).where(eq(schema.couriers.id, loaded.id));
        await patch(loaded.id, { status: "available" });
        assert.equal((await getCourier(loaded.id)).status, "busy");
      });

      it("«ocupado» a mano también se acepta", async () => {
        const courier = await createCourier({ status: "available" });
        await patch(courier.id, { status: "busy" });
        assert.equal((await getCourier(courier.id)).status, "busy");
      });

      for (const status of ["", "libre", "ONLINE", 5, null, undefined] as const) {
        it(`un estado inválido (${JSON.stringify(status)}): 400 «Estado inválido»`, async () => {
          const courier = await createCourier({ status: "available" });
          const res = await patch(courier.id, { status });
          assert.equal(res.status, 400);
          assert.deepEqual(await res.json(), { error: "Estado inválido" });
          assert.equal((await getCourier(courier.id)).status, "available");
        });
      }

      it("si el bot no responde, el cambio igual se guarda", async () => {
        const courier = await createCourier({ status: "available" });
        const waiting = await assignedTrip(courier.id);
        bot.reply("network");
        assert.equal((await patch(courier.id, { status: "offline" })).status, 200);
        assert.equal((await getTrip(waiting.id)).status, "pending");
      });
    });
  });

  describe("la ficha del motorizado (profile)", () => {
    const get = (id: number) => profile.GET(request("GET", `/api/couriers/${id}/profile`), params({ id }));
    const put = (id: number, body: unknown) => profile.PUT(request("PUT", `/api/couriers/${id}/profile`, { body }), params({ id }));

    it("sin ficha todavía: todo vacío", async () => {
      const courier = await createCourier();
      assert.deepEqual(await (await get(courier.id)).json(), {
        vehiclePlate: null,
        vehicleType: null,
        documentId: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
        gpsDeviceId: null,
        gpsConsentAt: null,
        onboardingCompletedAt: null,
      });
    });

    it("guarda la ficha, y la lee igual; la placa siempre queda igual («abc 12d» y «ABC-12D» son la misma moto)", async () => {
      const courier = await createCourier();
      const res = await put(courier.id, {
        vehiclePlate: " abc-12d ",
        vehicleType: "Moto 125",
        documentId: "1.234.567",
        emergencyContactName: "María",
        emergencyContactPhone: "3001112233",
      });
      assert.deepEqual(await res.json(), {
        vehiclePlate: "ABC12D",
        vehicleType: "Moto 125",
        documentId: "1.234.567",
        emergencyContactName: "María",
        emergencyContactPhone: "3001112233",
      });
      const read = (await (await get(courier.id)).json()) as { vehiclePlate: string };
      assert.equal(read.vehiclePlate, "ABC12D");
      for (const written of ["abc 12d", "ABC-12D", "Abc.12d"]) {
        const again = (await (await put(courier.id, { vehiclePlate: written })).json()) as { vehiclePlate: string };
        assert.equal(again.vehiclePlate, "ABC12D", written);
      }
    });

    it("el texto va recortado, con tope de largo, y vacío o que no es texto quiere decir «sin dato»", async () => {
      const courier = await createCourier();
      const res = await put(courier.id, {
        vehiclePlate: "x".repeat(40),
        vehicleType: "m".repeat(100),
        documentId: "   ",
        emergencyContactName: 123,
        emergencyContactPhone: null,
      });
      const body = (await res.json()) as Record<string, string | null>;
      assert.equal(body.vehiclePlate, "X".repeat(12));
      assert.equal(body.vehicleType!.length, 60);
      assert.deepEqual([body.documentId, body.emergencyContactName, body.emergencyContactPhone], [null, null, null]);
    });

    it("guardar de nuevo reemplaza (no apila) y no toca el identificador de GPS", async () => {
      const courier = await createCourier();
      await put(courier.id, { vehicleType: "Moto" });
      await (await gps.POST(request("POST", `/api/couriers/${courier.id}/gps`), params({ id: courier.id }))).json();
      await put(courier.id, { vehicleType: "Bicicleta" });
      const read = (await (await get(courier.id)).json()) as { vehicleType: string; gpsDeviceId: string | null };
      assert.equal(read.vehicleType, "Bicicleta");
      assert.match(read.gpsDeviceId ?? "", /^moto-/);
      assert.equal((await db.select().from(schema.courierProfiles)).length, 1);
    });
  });

  describe("GPS del motorizado", () => {
    const createId = (id: number) => gps.POST(request("POST", `/api/couriers/${id}/gps`), params({ id }));
    const send = (id: number, headers: Record<string, string> = {}) => gps.PUT(request("PUT", `/api/couriers/${id}/gps`, { headers }), params({ id }));

    it("genera el identificador que se pone en la app de su celular, y es siempre el mismo (cambiarlo obligaría a configurar la app otra vez)", async () => {
      const courier = await createCourier();
      const first = ((await (await createId(courier.id)).json()) as { gpsDeviceId: string }).gpsDeviceId;
      assert.match(first, /^moto-[A-Za-z0-9_-]{12}$/);
      const second = ((await (await createId(courier.id)).json()) as { gpsDeviceId: string }).gpsDeviceId;
      assert.equal(second, first);
      assert.equal((await db.select().from(schema.courierProfiles)).length, 1);
    });

    it("cada motorizado tiene el suyo", async () => {
      const a = await createCourier();
      const b = await createCourier();
      const idA = ((await (await createId(a.id)).json()) as { gpsDeviceId: string }).gpsDeviceId;
      const idB = ((await (await createId(b.id)).json()) as { gpsDeviceId: string }).gpsDeviceId;
      assert.notEqual(idA, idB);
    });

    it("un identificador ya puesto en la ficha no se pisa", async () => {
      const courier = await createCourier();
      await db.insert(schema.courierProfiles).values({ courierId: courier.id, gpsDeviceId: "moto-puesto-a-mano", vehicleType: "Moto" });
      const id = ((await (await createId(courier.id)).json()) as { gpsDeviceId: string }).gpsDeviceId;
      assert.equal(id, "moto-puesto-a-mano");
    });

    it("la ficha que ya tenía (sin identificador) lo recibe sin perder lo demás", async () => {
      const courier = await createCourier();
      await db.insert(schema.courierProfiles).values({ courierId: courier.id, vehicleType: "Moto" });
      const id = ((await (await createId(courier.id)).json()) as { gpsDeviceId: string }).gpsDeviceId;
      const [row] = await db.select().from(schema.courierProfiles);
      assert.deepEqual([row.gpsDeviceId, row.vehicleType], [id, "Moto"]);
    });

    describe("enviarlo por WhatsApp (PUT)", () => {
      it("le pide al bot que se lo mande, con la URL del servidor, y devuelve el identificador", async () => {
        const courier = await createCourier();
        process.env.BOT_HOST = "https://bot.clapi.test/";
        const res = await send(courier.id);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; gpsDeviceId: string };
        assert.match(body.gpsDeviceId, /^moto-/);
        assert.deepEqual(notifications().map((c) => c.body), [{ courierGps: courier.id, gpsUrl: "https://bot.clapi.test/api/gps" }]);
      });

      it("sin BOT_HOST, la URL sale del host con que se abrió el portal (bot.<host>)", async () => {
        const courier = await createCourier();
        await send(courier.id, { "x-forwarded-host": "portal.clapi.test" });
        assert.equal((notifications()[0].body as { gpsUrl: string }).gpsUrl, "https://bot.portal.clapi.test/api/gps");
        bot.calls.length = 0;
        await send(courier.id, { "x-forwarded-host": "bot.clapi.test, proxy.interno" });
        assert.equal((notifications()[0].body as { gpsUrl: string }).gpsUrl, "https://bot.clapi.test/api/gps");
      });

      it("desde localhost no inventa una URL: el bot usa la suya (o avisa que falta)", async () => {
        const courier = await createCourier();
        for (const host of ["localhost:3002", "127.0.0.1", "LOCALHOST"]) {
          bot.calls.length = 0;
          await send(courier.id, { "x-forwarded-host": host });
          assert.equal((notifications()[0].body as { gpsUrl?: string }).gpsUrl, undefined, host);
        }
      });

      it("si no ha escrito en las últimas 24 h (fuera de la ventana de WhatsApp): 409 «Pídele que escriba hola primero»", async () => {
        const courier = await createCourier();
        bot.reply({ status: 409, body: { ok: false, reason: "outside_window" } });
        const res = await send(courier.id);
        assert.equal(res.status, 409);
        const body = (await res.json()) as { error: string; gpsDeviceId: string };
        assert.equal(body.error, 'Pídele que escriba "hola" primero.');
        assert.match(body.gpsDeviceId, /^moto-/, "igual devuelve el identificador para dárselo por otro medio");
      });

      it("si falta BOT_HOST en el servidor: 502 con ese motivo", async () => {
        const courier = await createCourier();
        bot.reply({ status: 400, body: { ok: false, reason: "no_url" } });
        const res = await send(courier.id);
        assert.equal(res.status, 502);
        assert.equal(((await res.json()) as { error: string }).error, "Falta configurar BOT_HOST en el servidor.");
      });

      it("cualquier otra falla del bot (o sin bot): 502 «No se pudo enviar por WhatsApp»", async () => {
        const courier = await createCourier();
        for (const reply of [{ status: 500, body: {} }, "network"] as const) {
          bot.reply(reply);
          const res = await send(courier.id);
          assert.equal(res.status, 502);
          assert.equal(((await res.json()) as { error: string }).error, "No se pudo enviar por WhatsApp.");
        }
        bot.reply(null);
        delete process.env.BOT_URL;
        assert.equal((await send(courier.id)).status, 502);
      });
    });
  });

  // Los viajes de prueba no entran en la lista de otros motorizados.
  it("los pedidos de un motorizado no aparecen en la ficha de otro", async () => {
    const a = await createCourier({ status: "available" });
    const b = await createCourier({ status: "available" });
    await createTrip();
    await assignedTrip(a.id);
    const rows = (await (await couriers.GET()).json()) as { id: number; route: unknown[] }[];
    assert.equal(rows.find((r) => r.id === b.id)!.route.length, 0);
  });
});
