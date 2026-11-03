import { removeCourier, setCourierEmergency, updateCourierStatus } from "@/db/queries/couriers";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["available", "busy", "paused", "offline"];

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  if (body.active === false) {
    await removeCourier(Number(id));
    return Response.json({ ok: true });
  }

  if (typeof body.emergency === "boolean") {
    const courier = await setCourierEmergency(Number(id), body.emergency);
    return courier ? Response.json(courier) : Response.json({ error: "No existe" }, { status: 404 });
  }

  // La emergencia solo se pone y se quita con `emergency`: así siempre va con su chat.
  if (body.status === "paused") {
    return Response.json({ error: "Usa emergency" }, { status: 400 });
  }

  if (!VALID_STATUSES.includes(body.status)) {
    return Response.json({ error: "Estado inválido" }, { status: 400 });
  }

  const courier = await updateCourierStatus(Number(id), body.status);
  return Response.json(courier);
}
