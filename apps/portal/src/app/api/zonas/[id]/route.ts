import { deleteRestrictedZone, updateRestrictedZone, validateZone } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  const id = Number((await params).id);
  const zone = validateZone(await request.json().catch(() => null));
  if (!Number.isInteger(id) || !zone) return Response.json({ error: "Zona inválida" }, { status: 400 });
  const row = await updateRestrictedZone(id, zone);
  return row ? Response.json(row) : Response.json({ error: "No existe" }, { status: 404 });
}

export async function DELETE(_request: Request, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Zona inválida" }, { status: 400 });
  return (await deleteRestrictedZone(id)) ? Response.json({ ok: true }) : Response.json({ error: "No existe" }, { status: 404 });
}
