import { getFareRanges, saveFareRanges, validateFareRanges } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getFareRanges());
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  const ranges = validateFareRanges(body?.ranges);
  if (!ranges) return Response.json({ error: "Rangos inválidos" }, { status: 400 });
  await saveFareRanges(ranges);
  return Response.json({ ok: true });
}
