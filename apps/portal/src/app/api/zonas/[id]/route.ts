import { deleteServiceZone, updateServiceZone, validateServiceZone } from "@dispatch/shared/db";

import { currentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Cambiar el nombre o el borde de una zona de servicio. */
export async function PUT(request: Request, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Zona inválida" }, { status: 400 });
  const checked = validateServiceZone(await request.json().catch(() => null));
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
  const session = await currentSession();
  const row = await updateServiceZone(id, checked.zone, session?.userId ?? null);
  return row ? Response.json(row) : Response.json({ error: "Esa zona ya no existe" }, { status: 404 });
}

export async function DELETE(_request: Request, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Zona inválida" }, { status: 400 });
  const session = await currentSession();
  return (await deleteServiceZone(id, session?.userId ?? null))
    ? Response.json({ ok: true })
    : Response.json({ error: "Esa zona ya no existe" }, { status: 404 });
}
