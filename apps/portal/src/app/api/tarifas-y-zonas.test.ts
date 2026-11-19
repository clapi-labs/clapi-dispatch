import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, getFareRanges, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import { bot, createRestaurant, createUser, installMocks, openSession, params, request, resetMocks, restoreMocks, browser } from "@/test-support/portal-env";

/**
 * Tarifas y zonas de servicio desde el portal: la tabla por km, el ajuste de
 * precio por zona, el CRUD de zonas (cada cambio deja su versión, con quién lo
 * hizo) y «Probar» un punto. Las rutas se llaman tal cual, contra la base de
 * pruebas; el bot (que ubica direcciones y cotiza por calle) es de mentiras.
 * Sin `TEST_DATABASE_URL` se salta.
 */

type Ranges = typeof import("./fares/ranges/route");
type Adjustments = typeof import("./fares/ajustes/route");
type Zones = typeof import("./zonas/route");
type ZoneById = typeof import("./zonas/[id]/route");
type Probe = typeof import("./zonas/probar/route");
let ranges: Ranges;
let adjustments: Adjustments;
let zones: Zones;
let zoneById: ZoneById;
let probe: Probe;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  ranges = await import("./fares/ranges/route");
  adjustments = await import("./fares/ajustes/route");
  zones = await import("./zonas/route");
  zoneById = await import("./zonas/[id]/route");
  probe = await import("./zonas/probar/route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

/** Un cuadrado de ~2,2 km alrededor de (3,45, −76,53). */
const SQUARE = [
  { lat: 3.44, lng: -76.54 },
  { lat: 3.44, lng: -76.52 },
  { lat: 3.46, lng: -76.52 },
  { lat: 3.46, lng: -76.54 },
];
const zoneBody = (over: Record<string, unknown> = {}) => ({ name: "Ciudad Jardín", ring: SQUARE, barrioCode: null, fareAdjustment: 0, ...over });
const putRanges = (body: unknown) => ranges.PUT(request("PUT", "/api/fares/ranges", { body }));
const createZone = (body: unknown) => zones.POST(request("POST", "/api/zonas", { body }));
const updateZone = (id: number | string, body: unknown) => zoneById.PUT(request("PUT", `/api/zonas/${id}`, { body }), params({ id }));
const deleteZone = (id: number | string) => zoneById.DELETE(request("DELETE", `/api/zonas/${id}`), params({ id }));
const putAdjustments = (body: unknown) => adjustments.PUT(request("PUT", "/api/fares/ajustes", { body }));
const versions = () => db.select().from(schema.serviceZoneVersions).orderBy(schema.serviceZoneVersions.id);
const TABLE = [{ upToKm: 3, price: 5_000 }, { upToKm: 8, price: 8_000 }, { upToKm: null, price: 12_000 }];
/** Como queda guardada: el último tramo (sin tope) lleva siempre su tarifa por km adicional, 0 si no se puso. */
const STORED = [{ upToKm: 3, price: 5_000 }, { upToKm: 8, price: 8_000 }, { upToKm: null, price: 12_000, perKm: 0 }];

describe("tarifas y zonas del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("la tabla por km (/api/fares/ranges)", () => {
    it("sin tabla guardada, vacía (el bot no puede cotizar y escala)", async () => {
      assert.deepEqual(await (await ranges.GET()).json(), []);
    });

    it("guarda la tabla y la devuelve tal cual; la siguiente cotización ya la usa", async () => {
      const res = await putRanges({ ranges: TABLE });
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(await (await ranges.GET()).json(), STORED);
      assert.deepEqual(await getFareRanges(), STORED);
    });

    it("guardar de nuevo reemplaza la tabla (no apila)", async () => {
      await putRanges({ ranges: TABLE });
      await putRanges({ ranges: [{ upToKm: null, price: 7_000 }] });
      assert.deepEqual(await (await ranges.GET()).json(), [{ upToKm: null, price: 7_000, perKm: 0 }]);
      assert.equal((await db.select().from(schema.settings).where(eq(schema.settings.key, "fare_ranges"))).length, 1);
    });

    it("un tramo final con tarifa por km adicional se guarda", async () => {
      const table = [{ upToKm: 3, price: 5_000 }, { upToKm: null, price: 8_000, perKm: 1_000 }];
      assert.equal((await putRanges({ ranges: table })).status, 200);
      assert.deepEqual(await (await ranges.GET()).json(), table);
    });

    for (const [name, body] of [
      ["sin la lista", {}],
      ["con una lista vacía", { ranges: [] }],
      ["que no es una lista", { ranges: "5000" }],
      ["sin el tramo final (sin tope)", { ranges: [{ upToKm: 3, price: 5_000 }, { upToKm: 8, price: 8_000 }] }],
      ["con topes que no crecen", { ranges: [{ upToKm: 8, price: 5_000 }, { upToKm: 3, price: 8_000 }, { upToKm: null, price: 12_000 }] }],
      ["con un precio negativo", { ranges: [{ upToKm: 3, price: -1 }, { upToKm: null, price: 12_000 }] }],
      ["con un precio que no es entero", { ranges: [{ upToKm: 3, price: 5_000.5 }, { upToKm: null, price: 12_000 }] }],
      ["con un precio que no es número", { ranges: [{ upToKm: 3, price: "5000" }, { upToKm: null, price: 12_000 }] }],
      ["con un cuerpo vacío", null],
    ] as const) {
      it(`${name}: 400 «Rangos inválidos» y la tabla que había no se toca`, async () => {
        await putRanges({ ranges: TABLE });
        const res = await putRanges(body);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Rangos inválidos" });
        assert.deepEqual(await getFareRanges(), STORED);
      });
    }

    it("un cuerpo que no es JSON: 400", async () => {
      const res = await ranges.PUT(request("PUT", "/api/fares/ranges", { raw: "no es json" }));
      assert.equal(res.status, 400);
    });
  });

  describe("zonas de servicio (/api/zonas)", () => {
    it("sin zonas, lista vacía (no se restringe nada)", async () => {
      assert.deepEqual(await (await zones.GET()).json(), []);
    });

    describe("crear (POST)", () => {
      it("201 con la zona, y queda en la lista, ordenada por nombre", async () => {
        const res = await createZone(zoneBody({ name: "Zona B", fareAdjustment: 1_000 }));
        assert.equal(res.status, 201);
        const created = (await res.json()) as { id: number; name: string; fareAdjustment: number };
        assert.deepEqual([created.name, created.fareAdjustment], ["Zona B", 1_000]);
        await createZone(zoneBody({ name: "Zona A" }));
        assert.deepEqual(((await (await zones.GET()).json()) as { name: string }[]).map((z) => z.name), ["Zona A", "Zona B"]);
      });

      it("deja su primera versión en el historial, con quién la hizo", async () => {
        const user = await createUser();
        browser.cookie = (await openSession(user.id)).token;
        const created = (await (await createZone(zoneBody())).json()) as { id: number };
        const [v] = await versions();
        assert.deepEqual([v.zoneId, v.action, v.name, v.userId], [created.id, "creada", "Ciudad Jardín", user.id]);
      });

      it("el nombre y el código del barrio se limpian, el ajuste acepta texto con puntos y el borde se redondea a 6 decimales", async () => {
        const res = await createZone({ name: `  ${"X".repeat(150)}  `, ring: SQUARE.map((p) => ({ lat: p.lat + 0.00000049, lng: p.lng })), barrioCode: "B-12", fareAdjustment: "$ 2.500" });
        const body = (await res.json()) as { name: string; barrioCode: string; fareAdjustment: number; ring: { lat: number }[] };
        assert.equal(body.name.length, 120);
        assert.deepEqual([body.barrioCode, body.fareAdjustment], ["B-12", 2_500]);
        assert.equal(body.ring[0].lat, 3.44);
      });

      it("un código de barrio inválido se ignora (queda sin código)", async () => {
        const res = await createZone(zoneBody({ barrioCode: "con espacios y símbolos!" }));
        assert.equal(((await res.json()) as { barrioCode: string | null }).barrioCode, null);
      });

      it("un ajuste vacío o ausente es 0 (el precio de la tabla sin cambios)", async () => {
        for (const fareAdjustment of [undefined, null, ""]) {
          const body = (await (await createZone(zoneBody({ name: `Z${String(fareAdjustment)}`, fareAdjustment }))).json()) as { fareAdjustment: number };
          assert.equal(body.fareAdjustment, 0, String(fareAdjustment));
        }
      });

      it("un ajuste negativo (descuento) se acepta", async () => {
        const body = (await (await createZone(zoneBody({ fareAdjustment: -1_500 }))).json()) as { fareAdjustment: number };
        assert.equal(body.fareAdjustment, -1_500);
      });

      for (const [name, body, error] of [
        ["sin nombre", zoneBody({ name: "" }), "Falta el nombre"],
        ["con el nombre en blanco", zoneBody({ name: "   " }), "Falta el nombre"],
        ["sin borde", zoneBody({ ring: undefined }), "El borde debe tener de 3 a 500 esquinas"],
        ["con menos de 3 esquinas", zoneBody({ ring: SQUARE.slice(0, 2) }), "El borde debe tener de 3 a 500 esquinas"],
        ["con más de 500 esquinas", zoneBody({ ring: Array.from({ length: 501 }, (_, i) => ({ lat: 3.4 + i * 1e-5, lng: -76.5 })) }), "El borde debe tener de 3 a 500 esquinas"],
        ["con una esquina fuera de Colombia", zoneBody({ ring: [...SQUARE.slice(0, 3), { lat: 40, lng: -3 }] }), "El borde debe tener de 3 a 500 esquinas"],
        ["con una esquina que no es número", zoneBody({ ring: [...SQUARE.slice(0, 3), { lat: "norte", lng: -76.5 }] }), "El borde debe tener de 3 a 500 esquinas"],
        ["con un ajuste fuera de tope", zoneBody({ fareAdjustment: 200_001 }), "El ajuste debe ser un número entero de pesos, de −200.000 a 200.000"],
        ["con un ajuste que no es entero", zoneBody({ fareAdjustment: 10.5 }), "El ajuste debe ser un número entero de pesos, de −200.000 a 200.000"],
      ] as const) {
        it(`${name}: 400 «${error}» y no crea nada`, async () => {
          const res = await createZone(body);
          assert.equal(res.status, 400);
          assert.deepEqual(await res.json(), { error });
          assert.equal((await db.select().from(schema.serviceZones)).length, 0);
          assert.equal((await versions()).length, 0);
        });
      }

      it("un cuerpo que no es JSON: 400", async () => {
        const res = await zones.POST(request("POST", "/api/zonas", { raw: "no es json" }));
        assert.equal(res.status, 400);
      });
    });

    describe("editar (PUT /api/zonas/:id)", () => {
      it("cambia el nombre, el borde y el ajuste, y deja la versión «editada» con quién lo hizo", async () => {
        const user = await createUser();
        browser.cookie = (await openSession(user.id)).token;
        const { id } = (await (await createZone(zoneBody())).json()) as { id: number };
        const res = await updateZone(id, zoneBody({ name: "Ciudad Jardín Norte", fareAdjustment: 3_000 }));
        assert.equal(res.status, 200);
        assert.deepEqual([((await res.json()) as { name: string }).name], ["Ciudad Jardín Norte"]);
        const [created, edited] = await versions();
        assert.deepEqual([created.action, edited.action, edited.name, edited.fareAdjustment, edited.userId], ["creada", "editada", "Ciudad Jardín Norte", 3_000, user.id]);
      });

      it("una zona que ya no existe: 404", async () => {
        const res = await updateZone(99_999, zoneBody());
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Esa zona ya no existe" });
        assert.equal((await versions()).length, 0);
      });

      it("un id que no es número: 400", async () => {
        for (const id of ["abc", "1.5"]) assert.equal((await updateZone(id, zoneBody())).status, 400, id);
      });

      it("datos inválidos: 400 y la zona queda como estaba", async () => {
        const { id } = (await (await createZone(zoneBody())).json()) as { id: number };
        const res = await updateZone(id, zoneBody({ name: "" }));
        assert.equal(res.status, 400);
        assert.equal((await db.select().from(schema.serviceZones).where(eq(schema.serviceZones.id, id)))[0].name, "Ciudad Jardín");
      });
    });

    describe("borrar (DELETE /api/zonas/:id)", () => {
      it("borra la zona y guarda antes su última versión como «borrada»", async () => {
        const { id } = (await (await createZone(zoneBody({ fareAdjustment: 2_000 }))).json()) as { id: number };
        const res = await deleteZone(id);
        assert.deepEqual(await res.json(), { ok: true });
        assert.deepEqual(await (await zones.GET()).json(), []);
        const last = (await versions()).at(-1)!;
        assert.deepEqual([last.action, last.name, last.fareAdjustment], ["borrada", "Ciudad Jardín", 2_000]);
      });

      it("borrar dos veces: la segunda es 404", async () => {
        const { id } = (await (await createZone(zoneBody())).json()) as { id: number };
        await deleteZone(id);
        const res = await deleteZone(id);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "Esa zona ya no existe" });
      });

      it("un id que no es número: 400", async () => {
        assert.equal((await deleteZone("abc")).status, 400);
      });

      it("solo borra la que se pidió", async () => {
        const a = (await (await createZone(zoneBody({ name: "A" }))).json()) as { id: number };
        await createZone(zoneBody({ name: "B" }));
        await deleteZone(a.id);
        assert.deepEqual(((await (await zones.GET()).json()) as { name: string }[]).map((z) => z.name), ["B"]);
      });
    });
  });

  describe("el ajuste de precio de varias zonas (/api/fares/ajustes)", () => {
    it("cambia el ajuste de cada una, deja su versión y dice cuáles ya no existían", async () => {
      const user = await createUser();
      browser.cookie = (await openSession(user.id)).token;
      const a = (await (await createZone(zoneBody({ name: "A" }))).json()) as { id: number };
      const b = (await (await createZone(zoneBody({ name: "B" }))).json()) as { id: number };
      const res = await putAdjustments({ adjustments: [{ id: a.id, fareAdjustment: 1_000 }, { id: b.id, fareAdjustment: -500 }, { id: 99_999, fareAdjustment: 3 }] });
      assert.deepEqual(await res.json(), { ok: true, missing: [99_999] });
      const rows = Object.fromEntries((await db.select().from(schema.serviceZones)).map((z) => [z.name, z.fareAdjustment]));
      assert.deepEqual(rows, { A: 1_000, B: -500 });
      const edits = (await versions()).filter((v) => v.action === "editada");
      assert.deepEqual(edits.map((v) => [v.zoneId, v.fareAdjustment, v.userId]), [[a.id, 1_000, user.id], [b.id, -500, user.id]]);
    });

    it("el ajuste vacío es 0", async () => {
      const { id } = (await (await createZone(zoneBody({ fareAdjustment: 4_000 }))).json()) as { id: number };
      await putAdjustments({ adjustments: [{ id, fareAdjustment: "" }] });
      assert.equal((await db.select().from(schema.serviceZones))[0].fareAdjustment, 0);
    });

    for (const [name, body] of [
      ["sin la lista", {}],
      ["que no es una lista", { adjustments: "x" }],
      ["con más de 1.000", { adjustments: Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, fareAdjustment: 0 })) }],
      ["con un id que no es entero", { adjustments: [{ id: 1.5, fareAdjustment: 0 }] }],
      ["con un id ausente", { adjustments: [{ fareAdjustment: 0 }] }],
      ["con un ajuste fuera de tope", { adjustments: [{ id: 1, fareAdjustment: 999_999 }] }],
      ["con un elemento nulo", { adjustments: [null] }],
      ["con un cuerpo vacío", null],
    ] as const) {
      it(`${name}: 400 «Ajustes inválidos»`, async () => {
        const res = await putAdjustments(body);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Ajustes inválidos" });
      });
    }

    it("si un elemento es inválido no cambia ninguno de los demás", async () => {
      const { id } = (await (await createZone(zoneBody({ fareAdjustment: 4_000 }))).json()) as { id: number };
      const res = await putAdjustments({ adjustments: [{ id, fareAdjustment: 100 }, { id, fareAdjustment: 999_999 }] });
      assert.equal(res.status, 400);
      assert.equal((await db.select().from(schema.serviceZones))[0].fareAdjustment, 4_000);
    });
  });

  describe("«Probar» un punto (/api/zonas/probar)", () => {
    const test = (body: unknown) => probe.POST(request("POST", "/api/zonas/probar", { body }));
    const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

    it("sin zonas marcadas no se restringe nada", async () => {
      const body = await json(await test({ lat: 3.45, lng: -76.53 }));
      assert.equal(body.kind, "sin_zonas");
      assert.deepEqual([body.zones, body.nearest, body.quote], [[], null, null]);
    });

    it("dentro de una zona; cerca del borde (la central decide); y fuera y lejos (no hay servicio)", async () => {
      await createZone(zoneBody());
      const inside = await json(await test({ lat: 3.45, lng: -76.53 }));
      assert.equal(inside.kind, "dentro");
      assert.deepEqual((inside.zones as { name: string }[]).map((z) => z.name), ["Ciudad Jardín"]);
      const near = await json(await test({ lat: 3.4609, lng: -76.53 }));
      assert.equal(near.kind, "cerca");
      assert.equal((near.nearest as { name: string }).name, "Ciudad Jardín");
      assert.ok((near.nearest as { distanceM: number }).distanceM <= 300);
      const far = await json(await test({ lat: 3.6, lng: -76.53 }));
      assert.equal(far.kind, "fuera");
      assert.ok((far.nearest as { distanceM: number }).distanceM > 300);
      assert.equal(far.nearM, 300);
    });

    it("con una dirección escrita la ubica el bot, igual que una entrega", async () => {
      await createZone(zoneBody());
      bot.reply({ status: 200, body: { found: true, location: { lat: 3.45, lng: -76.53 }, neighborhood: "Ciudad Jardín" } });
      const body = await json(await test({ address: "Calle 10 # 5-20" }));
      assert.deepEqual([body.kind, body.neighborhood, body.point], ["dentro", "Ciudad Jardín", { lat: 3.45, lng: -76.53 }]);
      assert.deepEqual(bot.calls.map((c) => [c.path, c.body]), [["/api/internal/geocode", { address: "Calle 10 # 5-20" }]]);
    });

    it("si el mapa no la encuentra: 404 con el motivo; si no responde: 502", async () => {
      bot.reply({ status: 200, body: { found: false, reason: "not_found" } });
      const notFound = await test({ address: "Calle inventada" });
      assert.equal(notFound.status, 404);
      assert.match(((await notFound.json()) as { error: string }).error, /no encontró esa dirección/);
      bot.reply({ status: 500, body: {} });
      assert.equal((await test({ address: "Calle 10" })).status, 502);
      bot.reply("network");
      assert.equal((await test({ address: "Calle 10" })).status, 502);
      delete process.env.BOT_URL;
      const noBot = await test({ address: "Calle 10" });
      assert.equal(noBot.status, 502);
      assert.match(((await noBot.json()) as { error: string }).error, /BOT_URL o INTERNAL_SECRET/);
    });

    for (const [name, body] of [
      ["sin dirección ni punto", {}],
      ["con una latitud que no es número", { lat: "norte", lng: -76.5 }],
      ["con un cuerpo que no es JSON", undefined],
    ] as const) {
      it(`${name}: 400 «Falta la dirección o el punto»`, async () => {
        const res = body === undefined ? await probe.POST(request("POST", "/api/zonas/probar", { raw: "no es json" })) : await test(body);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Falta la dirección o el punto" });
      });
    }

    describe("con un restaurante: la cotización real desde él", () => {
      const withRestaurant = async (over: Record<string, unknown> = {}) =>
        createRestaurant({ name: "Pizza Nona", knownPickupAddress: "Calle 5", knownPickupLocation: { lat: 3.45, lng: -76.53 }, ...over });

      it("km, precio de la tabla, ajuste de la zona y total (el bot cotiza; sin respuesta se mide aquí con OSRM)", async () => {
        const restaurant = await withRestaurant();
        await putRanges({ ranges: TABLE });
        await createZone(zoneBody({ fareAdjustment: 1_500 }));
        bot.reply({ status: 200, body: { km: 1.4, source: "calle", routable: true, price: 6_500, breakdown: { table: 5_000, adjustment: 1_500, zone: { id: 1, name: "Ciudad Jardín" } }, coverage: "ok" } });
        const body = await json(await test({ lat: 3.455, lng: -76.53, restaurantId: restaurant.id }));
        assert.deepEqual(body.quote, { restaurant: "Pizza Nona", pickup: { lat: 3.45, lng: -76.53 }, km: 1.4, source: "calle", routable: true, table: 5_000, adjustment: 1_500, zone: { id: 1, name: "Ciudad Jardín" }, total: 6_500 });
        assert.equal(bot.calls[0].path, "/api/internal/quote");
      });

      it("si el bot no cotiza, se mide aquí con la tabla y las zonas guardadas", async () => {
        const restaurant = await withRestaurant();
        await putRanges({ ranges: TABLE });
        await createZone(zoneBody({ fareAdjustment: 1_500 }));
        bot.reply("network");
        const body = await json(await test({ lat: 3.455, lng: -76.53, restaurantId: restaurant.id }));
        const quote = body.quote as { total: number; table: number; adjustment: number; source: string; km: number };
        assert.deepEqual([quote.table, quote.adjustment, quote.total], [5_000, 1_500, 6_500]);
        assert.equal(quote.source, "linea_recta");
        assert.ok(quote.km > 0 && quote.km < 3);
      });

      it("fuera y lejos no se cotiza (el bot no lo tomaría)", async () => {
        const restaurant = await withRestaurant();
        await createZone(zoneBody());
        const body = await json(await test({ lat: 3.6, lng: -76.53, restaurantId: restaurant.id }));
        assert.equal(body.quote, null);
        assert.equal(bot.calls.length, 0);
      });

      it("un restaurante que no existe: 404; sin ubicación de recogida: 400", async () => {
        const gone = await test({ lat: 3.45, lng: -76.53, restaurantId: 99_999 });
        assert.equal(gone.status, 404);
        assert.deepEqual(await gone.json(), { error: "Ese restaurante ya no existe" });
        const noLocation = await withRestaurant({ knownPickupLocation: null });
        const res = await test({ lat: 3.45, lng: -76.53, restaurantId: noLocation.id });
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error: string }).error, /no tiene ubicación de recogida/);
      });

      it("un restaurantId vacío se ignora (solo se prueba el punto)", async () => {
        const body = await json(await test({ lat: 3.45, lng: -76.53, restaurantId: "" }));
        assert.equal(body.quote, null);
      });
    });

    it("no crea pedidos ni cambia las zonas guardadas", async () => {
      await createZone(zoneBody());
      const before = (await versions()).length;
      await test({ lat: 3.45, lng: -76.53 });
      assert.equal((await db.select().from(schema.trips)).length, 0);
      assert.equal((await versions()).length, before);
    });
  });
});
