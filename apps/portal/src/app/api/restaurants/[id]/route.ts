import { updateRestaurant, validateRestaurant } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Editar o desactivar. No se borran: los viajes viejos siguen apuntando a ellos. */
export async function PUT(request: Request, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Restaurante inválido" }, { status: 400 });
  const checked = validateRestaurant(await request.json().catch(() => null));
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
  const result = await updateRestaurant(id, checked.input);
  if (!result) return Response.json({ error: "No existe" }, { status: 404 });
  if ("error" in result) return Response.json({ error: result.error }, { status: 409 });
  return Response.json(result.restaurant);
}
