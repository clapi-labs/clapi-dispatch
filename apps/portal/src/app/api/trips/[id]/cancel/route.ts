import { cancelPendingErrand } from "@dispatch/shared/db";

export const dynamic = "force-dynamic";

/**
 * La central decide no hacer un encargo que sigue en Pendiente: se cancela sin
 * avisarle a nadie, porque lo que haya que decirle al restaurante se lo dice la
 * central por su chat. Solo encargos sin moto: cancelar viajes en general es
 * otra cosa. 409 si ya no se podía (tiene moto, ya se canceló o es un domicilio).
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tripId = Number((await params).id);
  if (!Number.isInteger(tripId) || tripId <= 0) return Response.json({ error: "Viaje inválido" }, { status: 400 });
  if (!(await cancelPendingErrand(tripId))) return Response.json({ error: "Solo se puede cancelar un encargo que sigue sin moto" }, { status: 409 });
  return Response.json({ ok: true });
}
