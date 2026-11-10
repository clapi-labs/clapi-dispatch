import { assignTripTo, db, returnTripToDispatch, schema } from "@dispatch/shared/db";
import { eq } from "drizzle-orm";

import { notifyBot } from "@/lib/bot";

export const dynamic = "force-dynamic";

/**
 * La central por encima del algoritmo. Un pedido pendiente se asigna a esa moto;
 * uno que ya tenía moto se le quita primero, si no lo ha recogido. Con `courierId`
 * nulo, solo se le quita: se vuelve a asignar solo.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tripId = Number((await params).id);
  const { courierId } = (await request.json()) as { courierId?: number | null };

  const [trip] = await db.select({ status: schema.trips.status }).from(schema.trips).where(eq(schema.trips.id, tripId)).limit(1);
  if (!trip) return Response.json({ error: "No existe" }, { status: 404 });

  const unassigned: { tripId: number; courierId: number }[] = [];
  if (trip.status !== "pending") {
    const returned = await returnTripToDispatch(tripId);
    if (!returned) return Response.json({ error: "Ya lo recogieron" }, { status: 409 });
    if (returned.courierId) unassigned.push({ tripId, courierId: returned.courierId });
  }

  const assigned = typeof courierId === "number" ? await assignTripTo(tripId, courierId, { byHand: true }) : null;
  await notifyBot({ unassigned, assigned: assigned ? [tripId] : [] });
  if (typeof courierId === "number" && !assigned) return Response.json({ error: "Esa moto ya no está disponible" }, { status: 409 });
  return Response.json({ ok: true });
}
