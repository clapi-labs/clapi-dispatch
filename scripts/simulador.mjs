// Simulador de staging: mueve las motos simuladas y reporta su posición por
// /api/gps, igual que Traccar Client en un celular. No asigna, no envía y no
// marca estados: a dónde va cada moto, y cuándo toca un botón por una que se
// maneja sola, se lo dice el bot (/api/internal/simulator). Si este proceso se
// detiene, el bot y el portal siguen y las motos quedan sin señal.
// Sin dependencias; corre con Node 22, como el worker.
//
//   SIMULATOR_ENABLED=1 BOT_URL=http://bot:3001 INTERNAL_SECRET=... node scripts/simulador.mjs

const BOT_URL = (process.env.BOT_URL ?? "").replace(/\/+$/, "");
const SECRET = process.env.INTERNAL_SECRET ?? "";
const TICK_MS = 1000;
/** En movimiento reporta cada 2 s; quieta, lo justo para no quedar sin señal. */
const MOVING_REPORT_MS = 2000;
const HEARTBEAT_MS = 10_000;
/** No repite el mismo botón antes de esto: el bot tarda en procesarlo. */
const ACT_RETRY_MS = 10_000;
// En línea recta: el engine supone 25 km/h por calles 1,3 veces más largas.
const SPEED_KMH = 25 / 1.3;

if (!["1", "true"].includes(process.env.SIMULATOR_ENABLED ?? "")) {
  console.log("[simulador] SIMULATOR_ENABLED no está activo: no hay nada que mover.");
  process.exit(0);
}
if (!BOT_URL || !SECRET) {
  console.error("[simulador] faltan BOT_URL o INTERNAL_SECRET");
  process.exit(1);
}

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => (stopping = true));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {Map<number, {lat: number, lng: number}>} */
const positions = new Map();
const lastReport = new Map();
const lastReported = new Map();
/** Paseo de las motos sin pedidos, para que no queden quietas. */
const wander = new Map();
const lastAct = new Map();

function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function moveTowards(from, to, stepKm) {
  const distance = km(from, to);
  if (distance <= stepKm || distance === 0) return to;
  const f = stepKm / distance;
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}

function randomNear(center, radiusKm) {
  const r = radiusKm * Math.sqrt(Math.random());
  const angle = Math.random() * 2 * Math.PI;
  return {
    lat: center.lat + (r / 111.32) * Math.cos(angle),
    lng: center.lng + (r / (111.32 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(angle),
  };
}

async function internal(method, body) {
  const res = await fetch(`${BOT_URL}/api/internal/simulator`, {
    method,
    headers: { "Content-Type": "application/json", "x-internal-secret": SECRET },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw Object.assign(new Error("el bot no tiene el simulador activo (SIMULATOR_ENABLED)"), { disabled: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Por la misma ruta que Traccar Client (protocolo OsmAnd). La hora va en
 *  milisegundos: dos reportes en el mismo segundo no se pisan. */
async function report(deviceId, p) {
  const url = `${BOT_URL}/api/gps?id=${encodeURIComponent(deviceId)}&lat=${p.lat}&lon=${p.lng}&timestamp=${Date.now()}&accuracy=5`;
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GPS HTTP ${res.status}`);
}

async function tick() {
  const state = await internal("GET");
  const stepKm = (SPEED_KMH * state.speed * TICK_MS) / 3_600_000;
  const now = Date.now();
  const tasks = [];

  for (const c of state.couriers) {
    // Desconectada en Flota: no se mueve ni reporta, queda sin señal.
    if (c.status !== "available" && c.status !== "busy") continue;
    if (!c.deviceId) continue;

    let position = positions.get(c.id) ?? (c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : randomNear(state.home, state.radiusKm * 0.6));
    let target = c.target;
    if (c.parked) {
      // Movida a mano desde el mapa: se queda ahí hasta que la suelten.
      position = c.parked;
      target = null;
      wander.delete(c.id);
    } else if (!target && !c.waiting) {
      let w = wander.get(c.id);
      if (!w || km(position, w) < 0.02) {
        w = randomNear(state.home, state.radiusKm * 0.6);
        wander.set(c.id, w);
      }
      target = w;
    } else {
      wander.delete(c.id);
    }
    if (target && km(position, target) > 0.001) position = moveTowards(position, target, stepKm);
    positions.set(c.id, position);

    const previous = lastReported.get(c.id);
    const moved = !previous || previous.lat !== position.lat || previous.lng !== position.lng;
    const since = now - (lastReport.get(c.id) ?? 0);
    if ((moved && since >= MOVING_REPORT_MS) || since >= HEARTBEAT_MS) {
      lastReport.set(c.id, now);
      lastReported.set(c.id, position);
      tasks.push(report(c.deviceId, position));
    }

    if (c.act && now - (lastAct.get(c.act) ?? 0) >= ACT_RETRY_MS) {
      lastAct.set(c.act, now);
      tasks.push(internal("POST", { action: "act", courierId: c.id, tripId: c.act }));
    }
  }

  const results = await Promise.allSettled(tasks);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

console.log(`[simulador] iniciado: ${BOT_URL}`);
let failures = 0;
let ready = false;
while (!stopping) {
  try {
    if (!ready) {
      const { created } = await internal("POST", { action: "setup" });
      if (created) console.log(`[simulador] ${created} motos simuladas creadas`);
      ready = true;
    }
    await tick();
    if (failures > 0) console.log("[simulador] recuperado");
    failures = 0;
  } catch (error) {
    failures += 1;
    if (failures === 1 || failures % 30 === 0) console.error(`[simulador] fallo (${failures}):`, error.message);
  }
  await sleep(failures ? Math.min(TICK_MS * 2 ** Math.min(failures, 4), 30_000) : TICK_MS);
}
console.log("[simulador] detenido");
