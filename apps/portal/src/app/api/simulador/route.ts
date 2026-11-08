import { and, desc, eq, gt, inArray, or } from "drizzle-orm";

import {
  createSimulatedCourier,
  db,
  getBotConfig,
  getEngineConfig,
  getSimulatorConfig,
  isSimulatedCourier,
  listControls,
  openTripCondition,
  randomPointNear,
  resetSimulation,
  schema,
  setEngineRadius,
  simulatorEnabled,
  simulatorHome,
  updateSimulatorConfig,
} from "@dispatch/shared/db";
import { orderStops, PHASE_LABEL, phaseSince, stopsForPhase, tripPhase } from "@dispatch/shared";

import { updateCourierStatus } from "@/db/queries/couriers";
import { callBot, notifyBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

/**
 * El mapa del simulador (/simulador). Solo lee y cambia lo propio del simulador;
 * los pedidos se crean en el bot, por el mismo camino que uno de WhatsApp. Sin
 * `SIMULATOR_ENABLED` no existe.
 */

const notFound = () => Response.json({ error: "No encontrado" }, { status: 404 });
const RECENT_MS = 12 * 60 * 60_000;
/** Lo que el engine considera sin señal se calcula aparte; esto es solo el mapa. */
type Point = { lat: number; lng: number };

export async function GET() {
  if (!simulatorEnabled()) return notFound();
  const [config, engine, bot, home, controls, couriers, restaurants] = await Promise.all([
    getSimulatorConfig(),
    getEngineConfig(),
    getBotConfig(),
    simulatorHome(),
    listControls(),
    db.select().from(schema.couriers).where(eq(schema.couriers.active, true)).orderBy(schema.couriers.id),
    db
      .select({ id: schema.restaurants.id, name: schema.restaurants.name, location: schema.restaurants.knownPickupLocation, phone: schema.restaurants.phone })
      .from(schema.restaurants)
      .where(eq(schema.restaurants.active, true))
      .orderBy(schema.restaurants.name),
  ]);

  const since = new Date(Date.now() - RECENT_MS);
  const rows = await db
    .select({ trip: schema.trips, assignment: schema.assignments, evaluation: schema.engineEvaluations })
    .from(schema.trips)
    .leftJoin(schema.assignments, eq(schema.assignments.tripId, schema.trips.id))
    .leftJoin(schema.engineEvaluations, eq(schema.engineEvaluations.tripId, schema.trips.id))
    .where(and(gt(schema.trips.createdAt, since), or(eq(schema.trips.status, "pending"), openTripCondition())))
    .orderBy(desc(schema.trips.createdAt));
  const ids = couriers.map((c) => c.id);
  const routes = ids.length ? await db.select().from(schema.courierRoutes).where(inArray(schema.courierRoutes.courierId, ids)) : [];

  const trips = rows.map(({ trip, assignment, evaluation }) => {
    const input = { ...(assignment ?? {}), status: trip.status };
    const phase = tripPhase(input);
    return {
      id: trip.id,
      code: trip.code,
      status: trip.status,
      phase,
      label: PHASE_LABEL[phase],
      phaseSince: phaseSince(input)?.toISOString() ?? null,
      leftDelivery: phase === "carrying" && Boolean(assignment?.leftDeliveryAt),
      restaurant: trip.originRestaurantName,
      pickup: trip.pickupLocation ?? null,
      delivery: trip.deliveryLocation ?? null,
      courierId: assignment?.courierId ?? null,
      readyAt: trip.readyAt?.toISOString() ?? null,
      evaluation: evaluation
        ? {
            status: evaluation.status,
            reason: evaluation.reason,
            courierId: evaluation.courierId,
            dispatchAt: evaluation.dispatchAt?.toISOString() ?? null,
            faltanMin: evaluation.faltanMin,
            response: evaluation.response,
          }
        : null,
    };
  });

  const names = new Map(couriers.map((c) => [c.id, c.name]));
  const connected = (c: (typeof couriers)[number]) => c.status === "available" || c.status === "busy";
  const controllerOf = (simId: number) => {
    const control = controls.find((x) => x.simCourierId === simId);
    const phone = control && couriers.find((c) => c.id === control.phoneCourierId);
    return phone && connected(phone) ? phone.name : null;
  };

  const courierView = couriers.map((c) => {
    const mine = trips.filter((t) => t.courierId === c.id && t.status !== "pending");
    const position = c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : null;
    const route = routes.find((r) => r.courierId === c.id)?.stops ?? null;
    const stops = orderStops(
      route,
      mine.map((t) => ({ id: t.id, stops: stopsForPhase(t.phase, false) })),
    );
    const path = stops
      .map((s) => {
        const t = mine.find((x) => x.id === s.pedido);
        return s.tipo === "C" || s.tipo === "W" ? t?.delivery : t?.pickup;
      })
      .filter((p): p is Point => !!p);
    return {
      id: c.id,
      name: c.name,
      simulated: c.simulated,
      status: c.status,
      lat: c.lat,
      lng: c.lng,
      locationUpdatedAt: c.locationUpdatedAt?.toISOString() ?? null,
      deliveriesThisShift: c.deliveriesThisShift,
      openTrips: mine.map((t) => ({ id: t.id, code: t.code, label: t.label })),
      controlledBy: c.simulated ? controllerOf(c.id) : null,
      controls: !c.simulated ? (() => {
        const control = controls.find((x) => x.phoneCourierId === c.id);
        return control?.simCourierId && connected(c) ? (names.get(control.simCourierId) ?? null) : null;
      })() : null,
      parked: config.parked[String(c.id)] ?? null,
      route: position ? [position, ...path] : path,
    };
  });

  return Response.json({
    now: new Date().toISOString(),
    config: {
      speed: config.speed,
      radiusKm: engine.radioKm,
      mode: engine.mode,
      sinSenalMin: engine.sinSenalMin,
      gatePercent: config.gatePercent,
      returnPercent: config.returnPercent,
      noAnswerPercent: config.noAnswerPercent,
      arrivalMeters: bot.gpsArrivalMeters,
    },
    home,
    couriers: courierView.filter((c) => c.simulated),
    testNumbers: courierView.filter((c) => !c.simulated).map((c) => ({ id: c.id, name: c.name, status: c.status, controls: c.controls })),
    restaurants: restaurants.filter((r) => r.location).map((r) => ({ id: r.id, name: r.name, location: r.location })),
    trips,
  });
}

export async function POST(request: Request) {
  if (!simulatorEnabled()) return notFound();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const courierId = num(body.courierId);
  const ok = () => Response.json({ ok: true });
  const bad = (error: string) => Response.json({ error }, { status: 400 });

  switch (body.action) {
    case "speed": {
      const value = num(body.value);
      if (value === null || value < 1 || value > 50) return bad("Velocidad entre 1 y 50");
      await updateSimulatorConfig(() => ({ speed: value }));
      return ok();
    }
    case "radius": {
      const value = num(body.value);
      if (value === null || value <= 0 || value > 30) return bad("Radio entre 0 y 30 km");
      await setEngineRadius(value);
      return ok();
    }
    case "outcomes": {
      const pct = (v: unknown) => (num(v) !== null && num(v)! >= 0 && num(v)! <= 100 ? num(v)! : null);
      const gate = pct(body.gatePercent);
      const back = pct(body.returnPercent);
      const noAnswer = pct(body.noAnswerPercent);
      if (gate === null || back === null || noAnswer === null) return bad("Porcentajes entre 0 y 100");
      await updateSimulatorConfig(() => ({ gatePercent: gate, returnPercent: back, noAnswerPercent: noAnswer }));
      return ok();
    }
    case "add": {
      const lat = num(body.lat);
      const lng = num(body.lng);
      const at = lat !== null && lng !== null ? { lat, lng } : randomPointNear(await simulatorHome(), (await getEngineConfig()).radioKm * 0.6);
      const courier = await createSimulatedCourier(at);
      return Response.json({ id: courier.id });
    }
    case "connect":
    case "disconnect": {
      if (courierId === null || !(await isSimulatedCourier(courierId))) return bad("No es una moto simulada");
      const { returned } = await updateCourierStatus(courierId, body.action === "connect" ? "available" : "offline");
      await notifyBot({ unassigned: returned.map((tripId) => ({ tripId, courierId })) });
      return ok();
    }
    case "park": {
      const lat = num(body.lat);
      const lng = num(body.lng);
      if (courierId === null || lat === null || lng === null || !(await isSimulatedCourier(courierId))) return bad("Falta la moto o el punto");
      await updateSimulatorConfig((c) => ({ parked: { ...c.parked, [String(courierId)]: { lat, lng } } }));
      return ok();
    }
    case "release": {
      if (courierId === null) return bad("Falta la moto");
      await updateSimulatorConfig((c) => {
        const parked = { ...c.parked };
        delete parked[String(courierId)];
        return { parked };
      });
      return ok();
    }
    case "order": {
      const result = await callBot("/api/internal/simulator", {
        action: "order",
        restaurantId: num(body.restaurantId),
        lat: num(body.lat),
        lng: num(body.lng),
        readyInMinutes: num(body.readyInMinutes) ?? 0,
      });
      return result.ok ? ok() : Response.json({ error: `El bot no creó el pedido (${result.reason ?? "error"})` }, { status: 502 });
    }
    case "reset": {
      const created = await resetSimulation();
      return Response.json({ ok: true, created });
    }
    default:
      return bad("Acción desconocida");
  }
}
