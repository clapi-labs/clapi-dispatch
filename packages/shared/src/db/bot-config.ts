import { eq } from "drizzle-orm";

import { DEFAULT_REQUIRED_FIELDS, type OrderFieldKey } from "../domain/extraction";
import { db } from "./client";
import { settings } from "./schema";

export const BOT_CONFIG_KEY = "bot_config";

/**
 * Lo que cambia de una agencia a otra en la conversación. El flujo es el
 * mismo para todas (docs/BOT.md); esto es lo que cada una ajusta.
 */
export type BotConfig = {
  /** Lo que hace falta para crear el viaje después de confirmar. */
  requiredFields: OrderFieldKey[];
  /** Distancia máxima por calles desde el restaurante; más lejos no hay
   *  cobertura. `null` = sin tope. */
  maxKm: number | null;
};

export const DEFAULT_BOT_CONFIG: BotConfig = {
  requiredFields: DEFAULT_REQUIRED_FIELDS,
  maxKm: 15,
};

/** La configuración guardada, con los valores por defecto en lo que falte. */
export async function getBotConfig(): Promise<BotConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, BOT_CONFIG_KEY));
  const saved = (row?.value ?? {}) as Partial<BotConfig>;
  return {
    requiredFields: Array.isArray(saved.requiredFields) ? saved.requiredFields : DEFAULT_BOT_CONFIG.requiredFields,
    maxKm: saved.maxKm === null || typeof saved.maxKm === "number" ? saved.maxKm : DEFAULT_BOT_CONFIG.maxKm,
  };
}
