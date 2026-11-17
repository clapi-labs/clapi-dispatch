import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { debtGroupKey, groupDebts, type DebtGroup, type DebtRow, type ReturnDebtReason } from "../domain/return-debts";
import { sameRestaurant } from "../domain/route";
import { db } from "./client";
import { assignments, couriers, returnDebtClaims, returnDebts, trips, users } from "./schema";

/**
 * Pendientes de regreso (docs/FLUJO-DOMICILIARIO.md, «Pendientes de regreso»):
 * lo que un domiciliario le debe a un restaurante después de entregar (el
 * datáfono o la plata de la comida). Las reglas puras están en
 * `domain/return-debts.ts`.
 */

export type ReturnDebt = typeof returnDebts.$inferSelect;
export type ReturnDebtClaim = typeof returnDebtClaims.$inferSelect;

/** Un pendiente con lo que hace falta para mostrarlo y agruparlo. */
export type ReturnDebtView = DebtRow & {
  courierName: string;
  courierPhone: string;
  declaredBy: "courier" | "central";
  reminderAt: Date | null;
  claimedAt: Date | null;
  closingNotifiedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: "courier" | "central" | null;
  resolvedByName: string | null;
};

const view = () => ({
  id: returnDebts.id,
  courierId: returnDebts.courierId,
  courierName: couriers.name,
  courierPhone: couriers.phone,
  restaurantId: returnDebts.restaurantId,
  restaurantName: returnDebts.restaurantName,
  reason: returnDebts.reason,
  tripId: returnDebts.tripId,
  tripCode: trips.code,
  createdAt: returnDebts.createdAt,
  deliveredAt: assignments.deliveredAt,
  declaredBy: returnDebts.declaredBy,
  reminderAt: returnDebts.reminderAt,
  claimedAt: returnDebts.claimedAt,
  closingNotifiedAt: returnDebts.closingNotifiedAt,
  resolvedAt: returnDebts.resolvedAt,
  resolvedBy: returnDebts.resolvedBy,
  resolvedByName: users.name,
});

function selectDebts() {
  return db
    .select(view())
    .from(returnDebts)
    .innerJoin(couriers, eq(couriers.id, returnDebts.courierId))
    .leftJoin(trips, eq(trips.id, returnDebts.tripId))
    .leftJoin(assignments, eq(assignments.tripId, returnDebts.tripId))
    .leftJoin(users, eq(users.id, returnDebts.resolvedByUserId));
}

/**
 * Anota un pendiente. Un pedido tiene a lo sumo uno abierto por motivo: un
 * doble toque no crea otro (`created: false` y el que ya había). Uno ya cerrado
 * no cuenta: se puede volver a declarar.
 */
export async function declareReturnDebt(input: {
  courierId: number;
  reason: ReturnDebtReason;
  restaurantName: string;
  restaurantId?: number | null;
  tripId?: number | null;
  declaredBy: "courier" | "central";
  userId?: number | null;
}): Promise<{ debt: ReturnDebt; created: boolean }> {
  const [created] = await db
    .insert(returnDebts)
    .values({
      courierId: input.courierId,
      reason: input.reason,
      restaurantName: input.restaurantName,
      restaurantId: input.restaurantId ?? null,
      tripId: input.tripId ?? null,
      declaredBy: input.declaredBy,
      declaredByUserId: input.userId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    if (input.declaredBy === "central") {
      await resolveDebtClaimsOfRestaurant({ restaurantId: input.restaurantId ?? null, restaurantName: input.restaurantName }, input.userId ?? null);
    }
    return { debt: created, created: true };
  }
  const [existing] = await db
    .select()
    .from(returnDebts)
    .where(and(eq(returnDebts.tripId, input.tripId ?? -1), eq(returnDebts.reason, input.reason), isNull(returnDebts.resolvedAt)))
    .limit(1);
  return { debt: existing, created: false };
}

/** Los abiertos, de un domiciliario o de todos. */
export async function openReturnDebts(courierId?: number): Promise<ReturnDebtView[]> {
  const rows = await selectDebts().where(and(isNull(returnDebts.resolvedAt), courierId === undefined ? undefined : eq(returnDebts.courierId, courierId)));
  return rows as ReturnDebtView[];
}

/** Los abiertos de un pedido. */
export async function openReturnDebtsOfTrip(tripId: number): Promise<ReturnDebtView[]> {
  return (await selectDebts().where(and(isNull(returnDebts.resolvedAt), eq(returnDebts.tripId, tripId)))) as ReturnDebtView[];
}

export async function getReturnDebt(id: number): Promise<ReturnDebtView | null> {
  const [row] = await selectDebts().where(eq(returnDebts.id, id)).limit(1);
  return (row as ReturnDebtView) ?? null;
}

/** El grupo abierto de un pendiente: los del mismo domiciliario, restaurante y motivo. */
export async function openGroupOf(debt: ReturnDebtView): Promise<DebtGroup<ReturnDebtView> | null> {
  const key = debtGroupKey(debt);
  const rows = (await openReturnDebts(debt.courierId)).filter((d) => debtGroupKey(d) === key);
  return groupDebts(rows)[0] ?? null;
}

/**
 * Cierra el grupo de un pendiente. La central cierra todo el grupo. El
 * domiciliario, con un datáfono, solo los de pedidos ya entregados (el de un
 * pedido que todavía lleva lo sigue usando); con plata, todo lo que le debe a
 * ese restaurante. Devuelve los que cerró.
 */
export async function resolveReturnDebtGroup(debtId: number, by: { kind: "courier" } | { kind: "central"; userId: number | null }): Promise<ReturnDebtView[]> {
  const debt = await getReturnDebt(debtId);
  if (!debt || debt.resolvedAt) return [];
  const group = await openGroupOf(debt);
  if (!group) return [];
  const closable = group.debts.filter((d) => by.kind === "central" || d.reason === "plata" || d.deliveredAt !== null || d.tripId === null);
  if (!closable.length) return [];
  const closed = await db
    .update(returnDebts)
    .set({ resolvedAt: new Date(), resolvedBy: by.kind, resolvedByUserId: by.kind === "central" ? by.userId : null })
    .where(and(inArray(returnDebts.id, closable.map((d) => d.id)), isNull(returnDebts.resolvedAt)))
    .returning({ id: returnDebts.id });
  const ids = new Set(closed.map((c) => c.id));
  if (ids.size > 0) {
    await resolveDebtClaimsOfRestaurant({ restaurantId: debt.restaurantId, restaurantName: debt.restaurantName }, by.kind === "central" ? by.userId : null);
  }
  return closable.filter((d) => ids.has(d.id));
}

/** Se le pidió cerrarlos (al entregar o con «Mandar ya»). */
export async function markReturnDebtsReminded(ids: number[]) {
  if (!ids.length) return;
  await db.update(returnDebts).set({ reminderAt: new Date() }).where(inArray(returnDebts.id, ids));
}

/** Se le avisó automáticamente al domiciliario porque el restaurante reclamó (#61). */
export async function markReturnDebtsClaimed(ids: number[], now = new Date()) {
  if (!ids.length) return;
  await db.update(returnDebts).set({ claimedAt: now, reminderAt: now }).where(inArray(returnDebts.id, ids));
}

/** Se le avisó al domiciliario unos minutos antes del cierre del restaurante (#61).
 *  Devuelve los ids que aún no se habían avisado, para que dos ticks en paralelo
 *  no manden el mensaje dos veces. */
export async function markReturnDebtsClosingNotified(ids: number[], now = new Date()): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await db
    .update(returnDebts)
    .set({ closingNotifiedAt: now, reminderAt: now })
    .where(and(inArray(returnDebts.id, ids), isNull(returnDebts.closingNotifiedAt), isNull(returnDebts.claimedAt)))
    .returning({ id: returnDebts.id });
  return rows.map((r) => r.id);
}

/** Reclamos abiertos que pasaron a la central (#61). */
export async function openDebtClaims(): Promise<ReturnDebtClaim[]> {
  return db
    .select()
    .from(returnDebtClaims)
    .where(isNull(returnDebtClaims.handledAt))
    .orderBy(desc(returnDebtClaims.updatedAt));
}

/**
 * Registra o actualiza un reclamo del restaurante para la central. Si ya había
 * uno abierto del mismo restaurante, lo actualiza en vez de apilar otro.
 */
export async function recordDebtClaim(
  input: {
    restaurantId?: number | null;
    restaurantName: string;
    conversationId?: number | null;
    reason: ReturnDebtReason | null;
    closing: boolean;
    why: string;
  },
  now = new Date(),
): Promise<ReturnDebtClaim> {
  const open = await openDebtClaims();
  const existing = open.find((c) => sameRestaurant({ restaurantId: input.restaurantId ?? null, restaurantName: input.restaurantName }, c));
  if (existing) {
    const [updated] = await db
      .update(returnDebtClaims)
      .set({
        reason: input.reason ?? existing.reason,
        closing: existing.closing || input.closing,
        why: input.why,
        updatedAt: now,
      })
      .where(eq(returnDebtClaims.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [created] = await db
    .insert(returnDebtClaims)
    .values({
      restaurantId: input.restaurantId ?? null,
      restaurantName: input.restaurantName,
      conversationId: input.conversationId ?? null,
      reason: input.reason,
      closing: input.closing,
      why: input.why,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}

/** La central marca un reclamo como atendido («Lo resuelvo yo», «Mandar ya» o al registrar/resolver el pendiente). */
export async function resolveDebtClaim(id: number, userId: number | null = null, now = new Date()): Promise<ReturnDebtClaim | null> {
  const [closed] = await db
    .update(returnDebtClaims)
    .set({ handledAt: now, handledByUserId: userId })
    .where(and(eq(returnDebtClaims.id, id), isNull(returnDebtClaims.handledAt)))
    .returning();
  return closed ?? null;
}

/** Cierra los reclamos abiertos de ese restaurante cuando la central actúa sobre su pendiente. */
export async function resolveDebtClaimsOfRestaurant(
  restaurant: { restaurantId: number | null; restaurantName: string },
  userId: number | null = null,
  now = new Date(),
) {
  const open = await openDebtClaims();
  const ids = open.filter((c) => sameRestaurant(restaurant, c)).map((c) => c.id);
  if (!ids.length) return;
  await db.update(returnDebtClaims).set({ handledAt: now, handledByUserId: userId }).where(inArray(returnDebtClaims.id, ids));
}

/** Lo que muestra el portal: los abiertos, los reclamos para la central y el historial de los cerrados. */
export async function returnDebtsForPortal(historyDays = 7): Promise<{ open: ReturnDebtView[]; resolved: ReturnDebtView[]; claims: ReturnDebtClaim[] }> {
  const [open, resolved, claims] = await Promise.all([
    openReturnDebts(),
    selectDebts()
      .where(and(isNotNull(returnDebts.resolvedAt), gt(returnDebts.resolvedAt, sql`now() - make_interval(days => ${historyDays})`)))
      .orderBy(desc(returnDebts.resolvedAt))
      .limit(200),
    openDebtClaims(),
  ]);
  return { open, resolved: resolved as ReturnDebtView[], claims };
}

/** Cuántos pendientes abiertos tiene cada domiciliario, por motivo: para Flota. */
export async function openReturnDebtCounts(): Promise<Map<number, { datafono: number; plata: number }>> {
  const rows = await db
    .select({ courierId: returnDebts.courierId, reason: returnDebts.reason, n: sql<number>`count(*)::int` })
    .from(returnDebts)
    .where(isNull(returnDebts.resolvedAt))
    .groupBy(returnDebts.courierId, returnDebts.reason);
  const counts = new Map<number, { datafono: number; plata: number }>();
  for (const r of rows) {
    const c = counts.get(r.courierId) ?? { datafono: 0, plata: 0 };
    c[r.reason] += r.n;
    counts.set(r.courierId, c);
  }
  return counts;
}
