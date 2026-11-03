import { createRestrictedZone, listRestrictedZones, validateZone } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

/** Zonas sin cobertura: las lee y las guarda el mapa de /zonas. */
export async function GET() {
  return Response.json(await listRestrictedZones());
}

export async function POST(request: Request) {
  const zone = validateZone(await request.json().catch(() => null));
  if (!zone) return Response.json({ error: "Zona inválida" }, { status: 400 });
  return Response.json(await createRestrictedZone(zone), { status: 201 });
}
