import { and, eq, inArray } from "drizzle-orm";

import {
  db,
  getBotConfig,
  getEngineConfig,
  getSimulatorConfig,
  listControls,
  listSimulatedCouriers,
  openTripCondition,
  schema,
  simulatorHome,
  type BotConfig,
  type SimulatorConfig,
} from "@dispatch/shared/db";
import { haversineKm, orderStops, stopsForPhase, tripPhase, type TripPhase } from "@dispatch/shared";

import { handleIncoming } from "@/bot/intake";
import { SIMULATED_ID_PREFIX } from "@/simulator/outbound";

/**
 * Qué hace cada moto simulada (docs/OPERACION.md, «Simulador»). Lo pide el
 * proceso de movimiento (scripts/simulador.mjs) cada segundo: solo mueve las
 * motos hacia `target`, reporta por /api/gps y, cuando aquí se le dice, toca el
 * botón por la moto. Todo sale de la fase de cada pedido, la misma que usa el
 * resto del sistema, y los estados por ubicación los marca gps.ts al recibir
 * las posiciones: aquí no se marca nada.
 */

type Point = { lat: number; lng: number };
type Trip = typeof schema.trips.$inferSelect;
type Assignment = typeof schema.assignments.$inferSelect;
type OpenTrip = { trip: Trip; assignment: Assignment; phase: TripPhase };

/** Lo que espera una moto que se maneja sola en la entrega antes de marcarla. */
const DELIVERY_PAUSE_MS = 15_000;

export type Move = {
  /** Hacia dónde va; `null` = no tiene a dónde ir (el proceso la pasea). */
  target: Point | null;
  /** Ya debe tocar un botón por ese pedido (solo las que se manejan solas). */
  act: number | null;
  /** Qué está esperando, para el mapa. */
  waiting: string | null;
};

const meters = (a: Point, b: Point) => haversineKm(a, b) * 1000;
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

/** A dónde va y qué le falta, según la fase de cada pedido en el orden de su ruta. */
export function nextMove(
  position: Point | null,
  open: OpenTrip[],
  route: { tipo: "R" | "C" | "W" | "V" | "B"; pedido: number }[] | null,
  controlled: boolean,
  bot: BotConfig,
  now: number,
): Move {
  const stops = orderStops(
    route,
    open.map((t) => ({ id: t.trip.id, stops: stopsForPhase(t.phase, false) })),
  );
  const near = (p: Point | null) => !!position && !!p && meters(position, p) <= bot.gpsArrivalMeters;

  for (const stop of stops) {
    const t = open.find((o) => o.trip.id === stop.pedido);
    if (!t) continue;
    const { trip, assignment: a, phase } = t;
    const pickup = trip.pickupLocation ?? null;
    const delivery = trip.deliveryLocation ?? null;

    if (stop.tipo === "R") {
      if (!pickup) continue;
      // Controlada: sale cuando el número toca «Voy en camino».
      if (controlled && (phase === "unread" || phase === "read")) return { target: null, act: null, waiting: "Espera «Voy en camino»" };
      if (a.atPickupAt) {
        const ready = !trip.readyAt || now >= trip.readyAt.getTime();
        const stayed = now - a.atPickupAt.getTime() >= (bot.gpsDwellSeconds + 5) * 1000;
        // Se la lleva: al alejarse, gps.ts cuenta que la recogió.
        if (!controlled && ready && stayed) continue;
        return { target: pickup, act: null, waiting: controlled ? "Espera «Recogí»" : ready ? "Recogiendo" : "Espera la comida" };
      }
      return { target: pickup, act: null, waiting: null };
    }

    if (stop.tipo === "C") {
      if (!delivery) return { target: null, act: controlled ? null : trip.id, waiting: controlled ? "Espera que marque la entrega" : null };
      const arrived = ms(a.atDeliveryAt);
      if (!controlled && arrived !== null && !a.leftDeliveryAt && now - arrived >= DELIVERY_PAUSE_MS) return { target: delivery, act: trip.id, waiting: "Marcando la entrega" };
      return { target: delivery, act: null, waiting: controlled && arrived !== null ? "Espera que marque la entrega" : null };
    }

    if (stop.tipo === "W") return { target: delivery, act: null, waiting: "Esperando al cliente" };

    if (stop.tipo === "V") {
      if (!pickup) return { target: null, act: controlled ? null : trip.id, waiting: null };
      if (near(pickup)) return { target: pickup, act: controlled ? null : trip.id, waiting: controlled ? "Espera «Devolví el pedido»" : null };
      return { target: pickup, act: null, waiting: null };
    }

    // B: vuelve a recogida; al llegar, gps.ts cierra el servicio.
    if (pickup) return { target: pickup, act: null, waiting: null };
  }
  return { target: null, act: null, waiting: null };
}

/** Lo que el proceso de movimiento necesita en cada vuelta. */
export async function simulatorState() {
  const [config, engine, bot, home, sims, controls] = await Promise.all([
    getSimulatorConfig(),
    getEngineConfig(),
    getBotConfig(),
    simulatorHome(),
    listSimulatedCouriers(),
    listControls(),
  ]);
  const ids = sims.map((s) => s.courier.id);
  const [rows, routes, connected] = ids.length
    ? await Promise.all([
        db
          .select({ trip: schema.trips, assignment: schema.assignments })
          .from(schema.assignments)
          .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
          .where(and(inArray(schema.assignments.courierId, ids), openTripCondition()))
          .orderBy(schema.assignments.assignedAt),
        db.select().from(schema.courierRoutes).where(inArray(schema.courierRoutes.courierId, ids)),
        db
          .select({ id: schema.couriers.id })
          .from(schema.couriers)
          .where(and(eq(schema.couriers.active, true), inArray(schema.couriers.status, ["available", "busy"]))),
      ])
    : [[], [], []];
  const isConnected = new Set(connected.map((c) => c.id));
  const controlledIds = new Set(controls.filter((c) => c.simCourierId !== null && isConnected.has(c.phoneCourierId)).map((c) => c.simCourierId));
  const now = Date.now();

  return {
    speed: config.speed,
    home,
    radiusKm: engine.radioKm,
    couriers: sims.map(({ courier, deviceId }) => {
      const open = rows
        .filter((r) => r.assignment.courierId === courier.id)
        .map((r) => ({ ...r, phase: tripPhase({ ...r.assignment, status: r.trip.status }) }));
      const position = courier.lat != null && courier.lng != null ? { lat: courier.lat, lng: courier.lng } : null;
      const controlled = controlledIds.has(courier.id);
      const route = routes.find((r) => r.courierId === courier.id)?.stops ?? null;
      return {
        id: courier.id,
        name: courier.name,
        deviceId,
        status: courier.status,
        lat: courier.lat,
        lng: courier.lng,
        controlled,
        parked: config.parked[String(courier.id)] ?? null,
        ...nextMove(position, open, route, controlled, bot, now),
      };
    }),
  };
}

/** Un número entre 0 y 99 que siempre es el mismo para ese pedido y esa pregunta. */
function roll(tripId: number, seed: number) {
  return (Math.imul(tripId ^ (seed * 0x9e3779b1), 0x85ebca6b) >>> 0) % 100;
}

/** Qué botón toca por ella una moto que se maneja sola. */
export function autoButton(tripId: number, phase: TripPhase, config: SimulatorConfig): { id: string; title: string } | null {
  if (phase === "undelivered") return { id: `returned:${tripId}`, title: "Devolví el pedido" };
  if (phase !== "carrying" && phase !== "at_delivery") return null;
  if (roll(tripId, 1) < config.noAnswerPercent) return { id: `noanswer:${tripId}`, title: "Cliente no contesta" };
  const gate = roll(tripId, 2) < config.gatePercent;
  const back = roll(tripId, 3) < config.returnPercent;
  return {
    id: `done:${gate ? "gate" : "customer"}:${back ? "return" : "finish"}:${tripId}`,
    title: `${gate ? "En portería" : "Entregado"}, ${back ? "vuelvo" : "terminé"}`,
  };
}

/**
 * Toca el botón por una moto que se maneja sola. Entra por el mismo camino que
 * un toque de WhatsApp (`handleIncoming`): queda en su chat y lo procesa el
 * mismo código. Una moto controlada no: eso lo hace el número de prueba.
 */
export async function actFor(courierId: number, tripId: number) {
  const [[row], controls, config] = await Promise.all([
    db
      .select({ trip: schema.trips, assignment: schema.assignments, courier: schema.couriers })
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .innerJoin(schema.couriers, eq(schema.couriers.id, schema.assignments.courierId))
      .where(and(eq(schema.assignments.tripId, tripId), eq(schema.assignments.courierId, courierId), eq(schema.couriers.simulated, true)))
      .limit(1),
    listControls(),
    getSimulatorConfig(),
  ]);
  if (!row) return null;
  if (controls.some((c) => c.simCourierId === courierId)) {
    const [controller] = await db
      .select({ status: schema.couriers.status, active: schema.couriers.active })
      .from(schema.couriers)
      .innerJoin(schema.simulatorControls, eq(schema.simulatorControls.phoneCourierId, schema.couriers.id))
      .where(eq(schema.simulatorControls.simCourierId, courierId))
      .limit(1);
    if (controller?.active && (controller.status === "available" || controller.status === "busy")) return null;
  }

  const button = autoButton(tripId, tripPhase({ ...row.assignment, status: row.trip.status }), config);
  if (!button) return null;
  await handleIncoming({
    waMessageId: `${SIMULATED_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    phone: row.courier.phone,
    profileName: null,
    timestamp: new Date(),
    kind: "button",
    buttonId: button.id,
    title: button.title,
  });
  return button.id;
}
