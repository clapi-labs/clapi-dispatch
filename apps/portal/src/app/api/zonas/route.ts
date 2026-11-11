import { createServiceZone, listServiceZones, validateServiceZone } from "@dispatch/shared/db";

import { currentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Zonas de servicio: las lee y las guarda el mapa de /zonas. */
export async function GET() {
  return Response.json(await listServiceZones());
}

export async function POST(request: Request) {
  const checked = validateServiceZone(await request.json().catch(() => null));
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
  const session = await currentSession();
  return Response.json(await createServiceZone(checked.zone, session?.userId ?? null), { status: 201 });
}
