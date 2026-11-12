import { db, getEngineConfig } from "@dispatch/shared/db";
import { sql } from "drizzle-orm";

import { lastWorkerTick } from "@/db/queries/worker-heartbeat";
import { assertEnv, env } from "@/env";
import { healthProblems } from "@/health/verdict";

export const dynamic = "force-dynamic";

/** Lo que más espera cada revisión: un servicio que no contesta en esto, está caído. */
const TIMEOUT_MS = 3000;
/** Es público: se recuerda la respuesta unos segundos para que nadie pueda
 *  martillar la base o el engine llamándolo seguido. */
const CACHE_MS = 10_000;

let cached: { at: number; ok: boolean } | null = null;

/**
 * ¿El sistema está sano? Lo consulta el monitoreo externo (docs/OPERACION.md,
 * «Avisos»), que avisa por Telegram si no. Hacia afuera solo dice `{ ok }`,
 * con 200 o 503; qué falló queda en los registros del bot.
 *
 * No lo usa Docker: para saber si el contenedor arrancó está `/api/live`, que
 * no depende del worker ni del engine (si no, un despliegue que los reinicia
 * parecería fallido y `deploy.sh` volvería atrás).
 */
export async function GET() {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const problems = await check();
    if (problems.length) console.error(`[health] no ok: ${problems.join("; ")}`);
    cached = { at: Date.now(), ok: problems.length === 0 };
  }
  return Response.json({ ok: cached.ok }, { status: cached.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

async function check(): Promise<string[]> {
  const now = new Date();
  const { missing } = assertEnv();

  const database = await within(db.execute(sql`select 1`)).then(
    () => true,
    () => false,
  );
  if (!database) return healthProblems({ now, missingEnv: missing, database, lastTickAt: null, engine: "off" });

  const [lastTickAt, engine] = await Promise.all([within(lastWorkerTick()).catch(() => null), engineState()]);
  return healthProblems({ now, missingEnv: missing, database, lastTickAt, engine });
}

/** El engine solo se revisa cuando asigna de verdad (modo `auto`). */
async function engineState(): Promise<"off" | "ok" | "down"> {
  const config = await within(getEngineConfig()).catch(() => null);
  if (config?.mode !== "auto") return "off";
  if (!env.engineUrl) return "down";
  try {
    const res = await fetch(`${env.engineUrl}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
