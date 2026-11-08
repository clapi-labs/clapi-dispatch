import { eq } from "drizzle-orm";

import { db } from "./client";
import { settings } from "./schema";

export const BUSINESS_KEY = "business";

/**
 * La pausa general de la agencia (por lluvia, por ejemplo). En pausa el bot
 * no le responde a nadie ni toma pedidos nuevos; lo que ya está en curso
 * sigue: el despacho asigna los pendientes, los avisos salen y lo que marca
 * el motorizado funciona. Las conversaciones quedan
 * como un WhatsApp normal para la central.
 */
export type BusinessState = { paused: boolean; pausedAt: string | null };

export async function getBusinessState(): Promise<BusinessState> {
  const [row] = await db.select().from(settings).where(eq(settings.key, BUSINESS_KEY));
  const saved = (row?.value ?? {}) as Partial<BusinessState>;
  return { paused: saved.paused === true, pausedAt: typeof saved.pausedAt === "string" ? saved.pausedAt : null };
}

export async function setBusinessPaused(paused: boolean): Promise<BusinessState> {
  const value: BusinessState = { paused, pausedAt: paused ? new Date().toISOString() : null };
  await db.insert(settings).values({ key: BUSINESS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return value;
}
