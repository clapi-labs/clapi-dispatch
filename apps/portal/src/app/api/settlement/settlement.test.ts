import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import { addDays, bogotaDate, weekRange } from "@/lib/week";
import { assignedTrip,createCourier, installMocks, resetMocks, restoreMocks, setAssignment } from "@/test-support/portal-env";

/**
 * El arqueo (`GET /api/settlement`): el cierre del día desde los viajes
 * ENTREGADOS hoy, con «hoy» medido en hora de Colombia (America/Bogota, UTC−5,
 * sin cambio de hora) y no en la del servidor, que es UTC. Se llama a la ruta
 * tal cual, contra la base de pruebas. Sin `TEST_DATABASE_URL` se salta.
 */

type Settlement = typeof import("./route");
let route: Settlement;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  route = await import("./route");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

/** La medianoche de Colombia de hoy, en UTC (05:00). */
function bogotaMidnight() {
  const shifted = new Date(Date.now() - 5 * 3600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) + 5 * 3600_000);
}

type Body = {
  total: number;
  deliveredCount: number;
  averageFee: number;
  agencyRate: number;
  agencyShare: number;
  couriers: { courierId: number; courierName: string; deliveredCount: number; earned: number; agencyShare: number }[];
};
const settle = async () => (await (await route.GET()).json()) as Body;

/** Un viaje entregado a esa hora, de esa moto, con ese domicilio. */
async function delivered(courierId: number, fee: number, at: Date, status: "delivered" | "cancelled" | "en_route" | "pending" = "delivered") {
  const trip = await assignedTrip(courierId, { deliveryFee: fee });
  await setAssignment(trip.id, { deliveredAt: at, finishedAt: at, deliveryPlace: "customer" });
  if (status !== "en_route") await db.update(schema.trips).set({ status }).where(eq(schema.trips.id, trip.id));
  return trip;
}

describe("arqueo del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  it("sin viajes entregados hoy: todo en cero", async () => {
    assert.deepEqual(await settle(), { total: 0, deliveredCount: 0, averageFee: 0, agencyRate: 0.1, agencyShare: 0, couriers: [] });
  });

  describe("solo cuentan los viajes entregados hoy, hora de Colombia", () => {
    it("lo entregado un minuto antes de la medianoche de Colombia es de ayer; un minuto después, de hoy", async () => {
      const courier = await createCourier({ status: "available" });
      const midnight = bogotaMidnight();
      await delivered(courier.id, 5_000, new Date(midnight.getTime() - 60_000));
      await delivered(courier.id, 7_000, new Date(midnight.getTime() + 60_000));
      const body = await settle();
      assert.deepEqual([body.deliveredCount, body.total], [1, 7_000]);
    });

    it("el límite exacto: la medianoche misma ya es de hoy", async () => {
      const courier = await createCourier({ status: "available" });
      await delivered(courier.id, 6_000, bogotaMidnight());
      assert.equal((await settle()).deliveredCount, 1);
    });

    it("«hoy» no es el día UTC: algo entregado a las 8 p. m. de Colombia (1 a. m. UTC de mañana) sigue siendo de hoy", async () => {
      const courier = await createCourier({ status: "available" });
      const midnight = bogotaMidnight();
      // 8:00 p. m. del día de Colombia que empezó en `midnight` (si todavía no llega esa hora, es una entrega en el «futuro» de hoy: igual es de hoy).
      await delivered(courier.id, 4_000, new Date(midnight.getTime() + 20 * 3600_000));
      assert.equal((await settle()).deliveredCount, 1);
    });

    it("y a las 11 p. m. de ayer en Colombia (4 a. m. UTC de hoy) ya es de ayer, aunque en UTC sea «hoy»", async () => {
      const courier = await createCourier({ status: "available" });
      const midnight = bogotaMidnight();
      const elevenPmYesterday = new Date(midnight.getTime() - 3600_000);
      assert.equal(elevenPmYesterday.getUTCHours(), 4, "las 23:00 de Colombia son las 04:00 UTC");
      await delivered(courier.id, 4_000, elevenPmYesterday);
      assert.equal((await settle()).deliveredCount, 0);
    });

    it("lo que se entregó hace días no cuenta", async () => {
      const courier = await createCourier({ status: "available" });
      await delivered(courier.id, 4_000, new Date(Date.now() - 3 * 86400_000));
      assert.equal((await settle()).deliveredCount, 0);
    });

    it("lo que no está en estado «entregado» no cuenta, aunque tenga una hora de entrega de hoy", async () => {
      const courier = await createCourier({ status: "available" });
      const now = new Date();
      await delivered(courier.id, 1_000, now, "cancelled");
      await delivered(courier.id, 2_000, now, "en_route");
      await delivered(courier.id, 3_000, now, "pending");
      assert.equal((await settle()).deliveredCount, 0);
    });

    it("un viaje entregado sin hora de entrega en la asignación (datos viejos) no cuenta", async () => {
      const courier = await createCourier({ status: "available" });
      const trip = await assignedTrip(courier.id, { deliveryFee: 5_000 });
      await db.update(schema.trips).set({ status: "delivered" }).where(eq(schema.trips.id, trip.id));
      assert.equal((await settle()).deliveredCount, 0);
    });

    it("cuenta igual la entrega al cliente y la de portería", async () => {
      const courier = await createCourier({ status: "available" });
      const now = new Date();
      const gate = await delivered(courier.id, 5_000, now);
      await setAssignment(gate.id, { deliveryPlace: "gate" });
      await delivered(courier.id, 5_000, now);
      assert.equal((await settle()).deliveredCount, 2);
    });
  });

  describe("semana (lunes a domingo) y día, hora de Colombia", () => {
    const get = (query: string) => route.GET(new Request(`http://portal.test/api/settlement${query}`));
    type Week = Body & { week: { start: string; end: string }; days: { date: string; deliveredCount: number; total: number; agencyShare: number }[]; day: string | null };

    it("?semana=: el acumulado lunes–domingo y siete días; lo de otras semanas no entra", async () => {
      const courier = await createCourier({ status: "available" });
      const monday = weekRange(bogotaDate(Date.now()));
      await delivered(courier.id, 5_000, new Date(monday.from.getTime() + 60_000)); // lunes 00:01
      await delivered(courier.id, 7_000, new Date(monday.to.getTime() - 60_000)); // domingo 23:59
      await delivered(courier.id, 9_000, new Date(monday.to.getTime() + 60_000)); // lunes siguiente
      await delivered(courier.id, 3_000, new Date(monday.from.getTime() - 60_000)); // domingo anterior
      const body = (await (await get(`?semana=${monday.days[3].date}`)).json()) as Week;
      assert.deepEqual([body.week.start, body.week.end, body.day], [monday.start, monday.end, null]);
      assert.deepEqual([body.deliveredCount, body.total], [2, 12_000]);
      assert.equal(body.days.length, 7);
      assert.deepEqual(body.days.map((d) => d.deliveredCount), [1, 0, 0, 0, 0, 0, 1]);
    });

    it("&dia=: solo ese día en las tarjetas y en las motos, y los siete días siguen completos", async () => {
      const courier = await createCourier({ name: "Pedro", status: "available" });
      const monday = weekRange(bogotaDate(Date.now()));
      await delivered(courier.id, 5_000, new Date(monday.days[1].from.getTime() + 3600_000));
      await delivered(courier.id, 7_000, new Date(monday.days[2].from.getTime() + 3600_000));
      const body = (await (await get(`?semana=${monday.start}&dia=${monday.days[2].date}`)).json()) as Week;
      assert.deepEqual([body.day, body.deliveredCount, body.total], [monday.days[2].date, 1, 7_000]);
      assert.deepEqual(body.couriers.map((c) => [c.courierName, c.earned]), [["Pedro", 7_000]]);
      assert.equal(body.days.reduce((s, d) => s + d.deliveredCount, 0), 2);
    });

    it("fechas inválidas o un día fuera de la semana: 400", async () => {
      const monday = weekRange(bogotaDate(Date.now()));
      assert.equal((await get("?semana=ayer")).status, 400);
      assert.equal((await get("?dia=2026-02-30")).status, 400);
      assert.equal((await get(`?semana=${monday.start}&dia=${addDays(monday.start, 7)}`)).status, 400);
    });
  });

  describe("las cuentas", () => {
    it("suma los domicilios (lo que cobra la agencia), no lo que cobra el restaurante al cliente", async () => {
      const courier = await createCourier({ status: "available" });
      const trip = await delivered(courier.id, 5_000, new Date());
      await db.update(schema.trips).set({ valueToCollect: 80_000 }).where(eq(schema.trips.id, trip.id));
      assert.equal((await settle()).total, 5_000);
    });

    it("el 10 % es de la agencia, en total y por moto; el promedio, redondeado", async () => {
      const pedro = await createCourier({ name: "Pedro", status: "available" });
      const now = new Date();
      await delivered(pedro.id, 5_000, now);
      await delivered(pedro.id, 8_000, now);
      await delivered(pedro.id, 5_000, now);
      const body = await settle();
      assert.deepEqual([body.total, body.deliveredCount, body.agencyRate, body.agencyShare], [18_000, 3, 0.1, 1_800]);
      assert.equal(body.averageFee, 6_000);
      assert.deepEqual(body.couriers, [{ courierId: pedro.id, courierName: "Pedro", deliveredCount: 3, earned: 18_000, agencyShare: 1_800 }]);
    });

    it("el promedio se redondea al peso", async () => {
      const courier = await createCourier({ status: "available" });
      const now = new Date();
      for (const fee of [5_000, 5_000, 6_001]) await delivered(courier.id, fee, now);
      assert.equal((await settle()).averageFee, Math.round(16_001 / 3));
    });

    it("por moto: agrupa por nombre y ordena de la que más generó a la que menos", async () => {
      const pedro = await createCourier({ name: "Pedro", status: "available" });
      const luis = await createCourier({ name: "Luis", status: "available" });
      const ana = await createCourier({ name: "Ana", status: "available" });
      const now = new Date();
      await delivered(pedro.id, 5_000, now);
      await delivered(luis.id, 8_000, now);
      await delivered(luis.id, 8_000, now);
      await delivered(ana.id, 12_000, now);
      const body = await settle();
      assert.deepEqual(body.couriers.map((c) => [c.courierName, c.deliveredCount, c.earned]), [["Luis", 2, 16_000], ["Ana", 1, 12_000], ["Pedro", 1, 5_000]]);
      assert.deepEqual(body.couriers.map((c) => c.agencyShare), [1_600, 1_200, 500]);
      assert.equal(body.total, 33_000);
    });

    it("la parte de la agencia por moto se redondea sola, y la del total sale del total (por eso pueden no sumar igual)", async () => {
      const pedro = await createCourier({ name: "Pedro", status: "available" });
      const luis = await createCourier({ name: "Luis", status: "available" });
      const now = new Date();
      await delivered(pedro.id, 5, now);
      await delivered(luis.id, 5, now);
      const body = await settle();
      assert.deepEqual(body.couriers.map((c) => c.agencyShare), [1, 1], "0,5 se redondea a 1 en cada una");
      assert.equal(body.agencyShare, 1, "y 1 sobre el total de 10");
    });

    it("un motorizado quitado de la flota sigue en el arqueo de lo que ya hizo", async () => {
      const courier = await createCourier({ name: "Quitado", status: "available" });
      await delivered(courier.id, 5_000, new Date());
      await db.update(schema.couriers).set({ active: false, status: "offline" }).where(eq(schema.couriers.id, courier.id));
      const body = await settle();
      assert.deepEqual(body.couriers.map((c) => c.courierName), ["Quitado"]);
    });

    it("un domicilio de 0 pesos (la central lo puso gratis) cuenta como viaje pero no suma", async () => {
      const courier = await createCourier({ status: "available" });
      await delivered(courier.id, 0, new Date());
      await delivered(courier.id, 6_000, new Date());
      const body = await settle();
      assert.deepEqual([body.deliveredCount, body.total, body.averageFee], [2, 6_000, 3_000]);
    });
  });
});
