import { getBusinessState, setBusinessPaused } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getBusinessState());
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.paused !== "boolean") return Response.json({ error: "Falta paused" }, { status: 400 });
  return Response.json(await setBusinessPaused(body.paused));
}
