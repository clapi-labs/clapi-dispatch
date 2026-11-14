import { validateFareAdjustment } from "@dispatch/shared";
import { setZoneAdjustments } from "@dispatch/shared/db";

import { currentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** El ajuste de precio de varias zonas a la vez, desde Tarifas:
 *  `{ adjustments: [{ id, fareAdjustment }] }`. Aplica desde la siguiente
 *  cotización; los pedidos que ya tienen precio no cambian. */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { adjustments?: unknown } | null;
  if (!Array.isArray(body?.adjustments) || body.adjustments.length > 1000) return Response.json({ error: "Ajustes inválidos" }, { status: 400 });
  const changes: { id: number; fareAdjustment: number }[] = [];
  for (const raw of body.adjustments as { id?: unknown; fareAdjustment?: unknown }[]) {
    const fareAdjustment = validateFareAdjustment(raw?.fareAdjustment);
    if (!Number.isInteger(raw?.id) || fareAdjustment === null) return Response.json({ error: "Ajustes inválidos" }, { status: 400 });
    changes.push({ id: raw.id as number, fareAdjustment });
  }
  const session = await currentSession();
  const missing = await setZoneAdjustments(changes, session?.userId ?? null);
  return Response.json({ ok: true, missing });
}
