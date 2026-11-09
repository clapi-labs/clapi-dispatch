import { createPriceZone, listPriceZones, validatePriceZone } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

/** Zonas con precio mínimo: las lee y las guarda el mapa de /precios-zona. */
export async function GET() {
  return Response.json(await listPriceZones());
}

export async function POST(request: Request) {
  const checked = validatePriceZone(await request.json().catch(() => null));
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
  return Response.json(await createPriceZone(checked.zone), { status: 201 });
}
