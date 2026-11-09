import { getServiceHours, setServiceHours, validateServiceHours } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

/** La hora de inicio de Express y la hora límite por defecto (docs/BOT.md, «Horario»). */
export async function GET() {
  return Response.json(await getServiceHours());
}

export async function PUT(request: Request) {
  const checked = validateServiceHours(await request.json().catch(() => null));
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
  return Response.json(await setServiceHours(checked.hours));
}
