import { createCourier, listCouriers } from "@/db/queries/couriers";
import { readJsonObject } from "@/lib/json";

export const dynamic = "force-dynamic";

export async function GET() {
  const couriers = await listCouriers();
  return Response.json(couriers);
}

export async function POST(request: Request) {
  const body = (await readJsonObject(request)) ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";

  if (!name || !phone) {
    return Response.json({ error: "Falta nombre o teléfono" }, { status: 400 });
  }

  const courier = await createCourier({
    name,
    phone,
    lat: typeof body.lat === "number" ? body.lat : undefined,
    lng: typeof body.lng === "number" ? body.lng : undefined,
  });

  return Response.json(courier, { status: 201 });
}
