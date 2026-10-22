// Worker: llama al bot cada pocos segundos para las tareas periódicas
// (asignar viajes pendientes, etc.). Sin dependencias; corre con Node 22.
//
//   BOT_URL=http://bot:3001 INTERNAL_SECRET=... node scripts/worker.mjs

const BOT_URL = (process.env.BOT_URL ?? "").replace(/\/+$/, "");
const SECRET = process.env.INTERNAL_SECRET ?? "";
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
const MAX_BACKOFF_MS = 60_000;

if (!BOT_URL || !SECRET) {
  console.error("[worker] faltan BOT_URL o INTERNAL_SECRET");
  process.exit(1);
}

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => (stopping = true));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tick() {
  const res = await fetch(`${BOT_URL}/api/internal/tick`, {
    method: "POST",
    headers: { "x-internal-secret": SECRET },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { assigned = [] } = await res.json();
  if (assigned.length) console.log(`[worker] asignados: ${assigned.join(", ")}`);
}

console.log(`[worker] iniciado: ${BOT_URL} cada ${INTERVAL_MS} ms`);
let failures = 0;
while (!stopping) {
  try {
    await tick();
    if (failures > 0) console.log("[worker] recuperado");
    failures = 0;
  } catch (error) {
    failures += 1;
    // Se avisa en el primer fallo y luego cada 10, para no llenar el log.
    if (failures === 1 || failures % 10 === 0) console.error(`[worker] fallo (${failures}):`, error.message);
  }
  // Con fallos seguidos espera más (hasta 1 min) para no martillar al bot.
  await sleep(Math.min(INTERVAL_MS * 2 ** Math.min(failures, 4), MAX_BACKOFF_MS));
}
console.log("[worker] detenido");
