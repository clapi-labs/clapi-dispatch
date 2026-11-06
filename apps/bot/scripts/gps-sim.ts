/**
 * Motos de prueba: se mueven por sus paradas y reportan la posición al bot por
 * `/api/gps`, igual que lo hará Traccar Client. Así se prueba en local todo lo que
 * depende del GPS, sin celulares. Solo corre contra una base local.
 *
 *   npm run bot:gps                 # a 25 km/h, como supone el engine
 *   npm run bot:gps -- --x10        # diez veces más rápido
 *
 * Quedan quietas en la entrega: marcarla le toca a quien esté probando, con
 * `npm run bot:chat` o desde el portal. Ahí está la gracia del botón.
 */
import { and, eq, inArray } from "drizzle-orm";

import { db, getBotConfig, openTripCondition, schema } from "@dispatch/shared/db";
import { haversineKm, orderStops, stopsForPhase, tripPhase } from "@dispatch/shared";

type Point = { lat: number; lng: number };

const BOT_URL = process.env.BOT_URL ?? "http://localhost:3001";
const SPEED_KMH = 25 / 1.3; // en línea recta: el engine supone 25 km/h por calles 1,3 veces más largas
const FACTOR = Number(process.argv.find((a) => a.startsWith("--x"))?.slice(3) ?? 1);
const TICK_MS = 1000;
const HEARTBEAT_MS = 10_000;
// El sur de Cali, para quien todavía no tiene posición.
const START = { lat: 3.385, lng: -76.53 };

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Este simulador solo corre contra una base local.");
  process.exit(1);
}

const positions = new Map<number, Point>();
const lastReport = new Map<number, number>();
/** Desde cuándo está en la recogida de cada viaje. */
const atPickup = new Map<number, number>();
/** Los viajes que ya se llevó: no vuelve por ellos aunque el bot aún no lo sepa. */
const leftPickup = new Set<number>();

async function deviceIds(courierIds: number[]) {
  const rows = await db.select().from(schema.courierProfiles).where(inArray(schema.courierProfiles.courierId, courierIds));
  const ids = new Map(rows.filter((r) => r.gpsDeviceId).map((r) => [r.courierId, r.gpsDeviceId!]));
  for (const id of courierIds) {
    if (ids.has(id)) continue;
    const device = `sim-${id}`;
    await db.insert(schema.courierProfiles).values({ courierId: id, gpsDeviceId: device }).onConflictDoUpdate({ target: schema.courierProfiles.courierId, set: { gpsDeviceId: device } });
    ids.set(id, device);
  }
  return ids;
}

function moveTowards(from: Point, to: Point, km: number): Point {
  const distance = haversineKm(from, to);
  if (distance <= km || distance === 0) return to;
  const f = km / distance;
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}

async function report(deviceId: string, p: Point) {
  const url = `${BOT_URL}/api/gps?id=${deviceId}&lat=${p.lat}&lon=${p.lng}&timestamp=${Math.floor(Date.now() / 1000)}&accuracy=5`;
  await fetch(url, { method: "POST" }).catch((error) => console.error("⚠️  el bot no responde:", error.message));
}

async function tick() {
  const [config, couriers, routes, rows] = await Promise.all([
    getBotConfig(),
    db.select().from(schema.couriers).where(and(eq(schema.couriers.active, true), inArray(schema.couriers.status, ["available", "busy"]))),
    db.select().from(schema.courierRoutes),
    db
      .select({ trip: schema.trips, assignment: schema.assignments })
      .from(schema.assignments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
      .where(openTripCondition())
      .orderBy(schema.assignments.assignedAt),
  ]);
  const devices = await deviceIds(couriers.map((c) => c.id));
  const stepKm = (SPEED_KMH * FACTOR * TICK_MS) / 3_600_000;
  const now = Date.now();

  await Promise.all(
    couriers.map(async (c) => {
      let position = positions.get(c.id) ?? (c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : { lat: START.lat + (c.id % 7) * 0.006, lng: START.lng + (c.id % 5) * 0.008 });
      const mine = rows.filter((r) => r.assignment.courierId === c.id);
      const stops = orderStops(
        routes.find((r) => r.courierId === c.id)?.stops,
        mine.map((r) => ({ id: r.trip.id, stops: stopsForPhase(tripPhase({ ...r.assignment, status: r.trip.status }), false) })),
      );

      // A qué parada va: si ya estuvo lo suficiente en la recogida y la comida está
      // lista, sigue a la siguiente, y al salir el bot cuenta que la recogió.
      let target: Point | null = null;
      for (const stop of stops) {
        const trip = mine.find((r) => r.trip.id === stop.pedido)!.trip;
        if (stop.tipo === "R" && trip.pickupLocation) {
          if (leftPickup.has(trip.id)) continue;
          if (haversineKm(position, trip.pickupLocation) * 1000 <= config.gpsArrivalMeters * 0.5) {
            if (!atPickup.has(trip.id)) atPickup.set(trip.id, now);
            const stayed = now - atPickup.get(trip.id)! >= (config.gpsDwellSeconds + 3) * 1000;
            if (stayed && (!trip.readyAt || trip.readyAt.getTime() <= now)) {
              leftPickup.add(trip.id);
              continue;
            }
          }
          target = trip.pickupLocation;
        } else {
          target = (stop.tipo === "C" || stop.tipo === "W" ? trip.deliveryLocation : trip.pickupLocation) ?? null;
        }
        if (target) break;
      }

      const moving = target !== null && haversineKm(position, target) > 0.001;
      if (moving) position = moveTowards(position, target!, stepKm);
      positions.set(c.id, position);

      // En movimiento reporta seguido; quieta, lo justo para no quedar «sin señal».
      if (moving || now - (lastReport.get(c.id) ?? 0) >= HEARTBEAT_MS) {
        lastReport.set(c.id, now);
        await report(devices.get(c.id)!, position);
      }
    }),
  );
}

console.log(`Motos de prueba reportando a ${BOT_URL} (×${FACTOR}). Ctrl+C para parar.`);
setInterval(() => void tick().catch((error) => console.error("⚠️ ", error)), TICK_MS);
