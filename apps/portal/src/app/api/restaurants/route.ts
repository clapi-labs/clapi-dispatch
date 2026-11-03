import { createRestaurant, listRestaurants, validateRestaurant } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

/** Restaurantes registrados: el bot los reconoce por el número y recoge en su ubicación. */
export async function GET() {
  return Response.json(await listRestaurants());
}

export async function POST(request: Request) {
  const checked = validateRestaurant(await request.json().catch(() => null));
  if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
  const result = await createRestaurant(checked.input);
  if ("error" in result) return Response.json({ error: result.error }, { status: 409 });
  return Response.json(result.restaurant, { status: 201 });
}
