import { deleteRestaurant, setRestaurantPhoto, updateRestaurant, validateRestaurant } from "@dispatch/shared/db";

import { isValidPhoto } from "@/lib/photo";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Editar o desactivar. */
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

export async function PATCH(request: Request, { params }: Params) {
  const id = Number((await params).id);
  const body = await request.json().catch(() => null);
  if (!Number.isInteger(id) || !isValidPhoto(body?.photo)) return Response.json({ error: "Foto inválida" }, { status: 400 });
  const restaurant = await setRestaurantPhoto(id, body.photo);
  return restaurant ? Response.json(restaurant) : Response.json({ error: "No existe" }, { status: 404 });
}

export async function DELETE(_request: Request, { params }: Params) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Restaurante inválido" }, { status: 400 });
  const restaurant = await deleteRestaurant(id);
  return restaurant ? Response.json({ ok: true }) : Response.json({ error: "No existe" }, { status: 404 });
}
