import { eq } from "drizzle-orm";

import { DEFAULT_SERVICE_HOURS, normalizeClock, type ServiceHours } from "../domain/service-hours";
import { db } from "./client";
import type { Restaurant } from "./restaurants";
import { settings } from "./schema";

export const SERVICE_HOURS_KEY = "service_hours";

/** La hora de inicio y la hora límite por defecto, como las dejó la central. */
export async function getServiceHours(): Promise<ServiceHours> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SERVICE_HOURS_KEY));
  const saved = (row?.value ?? {}) as Partial<ServiceHours>;
  return {
    opensAt: normalizeClock(saved.opensAt) ?? DEFAULT_SERVICE_HOURS.opensAt,
    defaultDeadline: normalizeClock(saved.defaultDeadline) ?? DEFAULT_SERVICE_HOURS.defaultDeadline,
  };
}

export async function setServiceHours(value: ServiceHours): Promise<ServiceHours> {
  await db.insert(settings).values({ key: SERVICE_HOURS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return value;
}

/** Revisa lo que manda el portal. */
export function validateServiceHours(body: unknown): { hours: ServiceHours } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const opensAt = normalizeClock(b.opensAt);
  const defaultDeadline = normalizeClock(b.defaultDeadline);
  if (!opensAt) return { error: "La hora de inicio no es válida" };
  if (!defaultDeadline) return { error: "La hora límite no es válida" };
  return { hours: { opensAt, defaultDeadline } };
}

/** El horario de un restaurante: el inicio de todos y su hora límite, o la de
 *  por defecto si no tiene una propia (o no está registrado). */
export function hoursFor(restaurant: Pick<Restaurant, "orderDeadline"> | null, hours: ServiceHours) {
  return { opensAt: hours.opensAt, deadline: restaurant?.orderDeadline ?? hours.defaultDeadline };
}
