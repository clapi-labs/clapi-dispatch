import { DEFAULT_DATAFONO_ALERT_MINUTES } from "@dispatch/shared";
import { db, declareReturnDebt, getBotConfig, returnDebtsForPortal, saveDatafonoAlertMinutes, schema } from "@dispatch/shared/db";
import { and, desc, eq } from "drizzle-orm";

import { currentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Pendientes de regreso (docs/FLUJO-DOMICILIARIO.md, «Pendientes de regreso»):
 * los abiertos y el historial de los cerrados en los últimos 7 días, con los
 * minutos del aviso del datáfono.
 */
export async function GET() {
  const [{ open, resolved, claims }, config] = await Promise.all([returnDebtsForPortal(), getBotConfig()]);
  return Response.json({
    open,
    resolved,
    claims,
    datafonoAlertMinutes: config.datafonoAlertMinutes,
    closingDebtMinutes: config.closingDebtMinutes,
  });
}

/**
 * La central registra uno a mano: el domiciliario no lo declaró y el
 * restaurante reclama. `{ courierId, reason, restaurantId? | restaurantName?,
 * tripCode? }`. Con el código de un pedido de ese domiciliario, el restaurante
 * sale del pedido.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    courierId?: unknown;
    reason?: unknown;
    restaurantId?: unknown;
    restaurantName?: unknown;
    tripCode?: unknown;
  };
  const courierId = Number(body.courierId);
  const reason = body.reason === "datafono" || body.reason === "plata" ? body.reason : null;
  if (!Number.isInteger(courierId) || !reason) return Response.json({ error: "Falta el domiciliario o el motivo" }, { status: 400 });
  const [courier] = await db.select().from(schema.couriers).where(eq(schema.couriers.id, courierId)).limit(1);
  if (!courier) return Response.json({ error: "Ese domiciliario ya no existe" }, { status: 404 });

  let trip: typeof schema.trips.$inferSelect | null = null;
  const code = typeof body.tripCode === "string" ? body.tripCode.trim().toUpperCase().replace(/^([A-Z])(\d)/, "$1-$2") : "";
  if (code) {
    const [row] = await db
      .select({ trip: schema.trips })
      .from(schema.trips)
      .innerJoin(schema.assignments, eq(schema.assignments.tripId, schema.trips.id))
      .where(and(eq(schema.trips.code, code), eq(schema.assignments.courierId, courierId)))
      .orderBy(desc(schema.trips.createdAt))
      .limit(1);
    if (!row) return Response.json({ error: `${courier.name} no tiene un pedido ${code}` }, { status: 404 });
    trip = row.trip;
  }

  let restaurantId: number | null = trip?.restaurantId ?? null;
  let restaurantName = trip?.originRestaurantName ?? "";
  if (!trip) {
    const id = Number(body.restaurantId);
    if (Number.isInteger(id) && id > 0) {
      const [r] = await db.select().from(schema.restaurants).where(eq(schema.restaurants.id, id)).limit(1);
      if (!r) return Response.json({ error: "Ese restaurante ya no existe" }, { status: 404 });
      restaurantId = r.id;
      restaurantName = r.name;
    } else {
      restaurantName = typeof body.restaurantName === "string" ? body.restaurantName.trim().slice(0, 120) : "";
    }
  }
  if (!restaurantName) return Response.json({ error: "Falta el restaurante" }, { status: 400 });

  const session = await currentSession();
  const { debt, created } = await declareReturnDebt({
    courierId,
    reason,
    restaurantId,
    restaurantName,
    tripId: trip?.id ?? null,
    declaredBy: "central",
    userId: session?.userId ?? null,
  });
  if (!created) return Response.json({ error: `Ese pedido ya tiene anotado ${reason === "datafono" ? "el datáfono" : "la plata"}` }, { status: 409 });
  return Response.json(debt, { status: 201 });
}

/** Los minutos del aviso del datáfono y del recordatorio antes del cierre (`settings.bot_config`). */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { datafonoAlertMinutes?: unknown; closingDebtMinutes?: unknown };
  const config = await getBotConfig();
  const minutes = body.datafonoAlertMinutes !== undefined ? Number(body.datafonoAlertMinutes) : config.datafonoAlertMinutes;
  const closingMinutes = body.closingDebtMinutes !== undefined ? Number(body.closingDebtMinutes) : config.closingDebtMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    return Response.json({ error: `Los minutos van de 1 a 1.440 (por defecto, ${DEFAULT_DATAFONO_ALERT_MINUTES})` }, { status: 400 });
  }
  if (!Number.isInteger(closingMinutes) || closingMinutes < 1 || closingMinutes > 24 * 60) {
    return Response.json({ error: "Los minutos antes del cierre van de 1 a 1.440" }, { status: 400 });
  }
  await saveDatafonoAlertMinutes(minutes, closingMinutes);
  return Response.json({ ok: true, datafonoAlertMinutes: minutes, closingDebtMinutes: closingMinutes });
}
