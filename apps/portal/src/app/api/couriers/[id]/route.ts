import type { CourierStatus } from "@dispatch/shared/db/schema";

import { removeCourier, setCourierEmergency, setCourierPhoto, updateCourierStatus } from "@/db/queries/couriers";
import { notifyBot } from "@/lib/bot";
import { readJsonObject } from "@/lib/json";
import { isValidPhoto } from "@/lib/photo";

export const dynamic = "force-dynamic";

const VALID_STATUSES = ["available", "busy", "paused", "offline"];

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await readJsonObject(request)) ?? {};

  if (body.active === false) {
    await removeCourier(Number(id));
    return Response.json({ ok: true });
  }

  if ("photo" in body) {
    if (!isValidPhoto(body.photo)) return Response.json({ error: "Foto inválida" }, { status: 400 });
    const courier = await setCourierPhoto(Number(id), body.photo);
    return courier ? Response.json(courier) : Response.json({ error: "No existe" }, { status: 404 });
  }

  if (typeof body.emergency === "boolean") {
    const courier = await setCourierEmergency(Number(id), body.emergency);
    return courier ? Response.json(courier) : Response.json({ error: "No existe" }, { status: 404 });
  }

  // La emergencia solo se pone y se quita con `emergency`: así siempre va con su chat.
  if (body.status === "paused") {
    return Response.json({ error: "Usa emergency" }, { status: 400 });
  }

  if (typeof body.status !== "string" || !VALID_STATUSES.includes(body.status)) {
    return Response.json({ error: "Estado inválido" }, { status: 400 });
  }

  const { courier, returned } = await updateCourierStatus(Number(id), body.status as CourierStatus);
  await notifyBot({ unassigned: returned.map((tripId) => ({ tripId, courierId: Number(id) })) });
  return Response.json(courier);
}
