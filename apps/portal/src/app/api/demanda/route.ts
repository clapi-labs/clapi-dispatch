import { getDemand, getDemandConfig, listDemandChanges, measureDemand, setDemandConfig } from "@dispatch/shared/db";
import { demandSignal, demandSummary, validateDemandConfig } from "@dispatch/shared/domain/demand";

export const dynamic = "force-dynamic";

/**
 * La demanda (docs/ALGORITMO.md, «Demanda»): el nivel como lo dejó el tick,
 * los números de este momento con su porqué y los umbrales. Con `?registro=1`
 * también los últimos cambios de nivel.
 */
export async function GET(request: Request) {
  const now = new Date();
  const withLog = new URL(request.url).searchParams.get("registro") === "1";
  const [state, config, changes] = await Promise.all([getDemand(now), getDemandConfig(), withLog ? listDemandChanges(50) : null]);
  const metrics = await measureDemand(config, now);
  return Response.json({
    ...state,
    now: { metrics, signal: demandSignal(metrics, config), summary: demandSummary(metrics) },
    config,
    changes: changes?.map((c) => ({ ...c, summary: demandSummary(c.metrics) })) ?? null,
  });
}

/** Los umbrales: el siguiente tick ya los usa, sin desplegar. */
export async function PUT(request: Request) {
  const checked = validateDemandConfig(await request.json().catch(() => null));
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
  return Response.json(await setDemandConfig(checked.config));
}
