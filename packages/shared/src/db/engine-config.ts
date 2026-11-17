import { eq } from "drizzle-orm";

import { db } from "./client";
import { settings } from "./schema";

export const ENGINE_CONFIG_KEY = "engine_config";

/**
 * Cómo usa el despacho al engine (docs/ALGORITMO.md). Se cambia en la base,
 * sin redesplegar.
 */
export type EngineConfig = {
  /** `auto`: el engine asigna; si no hay GPS o falla, los pedidos esperan y la
   *  central los asigna a mano. `manual`: el engine no corre y asigna solo la
   *  central. Los valores viejos (`queue`, `shadow`) de la época de la cola se
   *  leen como `auto`. */
  mode: "auto" | "manual";
  /** Las motos más lejos que esto del restaurante no participan. Una moto sin
   *  señal tampoco (`NO_SIGNAL_MS`, domain/gps.ts: fijo en 30 segundos). */
  radioKm: number;
  /** Si una moto ocupada puede recibir otro pedido. */
  multipedido: boolean;
};

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  mode: "auto",
  radioKm: 4,
  multipedido: true,
};

/** La configuración guardada tal como está en la base, con los valores por
 *  defecto en lo que falte o no se entienda. Sin tocar la base, para probarla. */
export function normalizeEngineConfig(value: unknown): EngineConfig {
  const saved = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const positive = (n: unknown, fallback: number) => (typeof n === "number" && n > 0 ? n : fallback);
  return {
    mode: saved.mode === "manual" ? "manual" : DEFAULT_ENGINE_CONFIG.mode,
    radioKm: positive(saved.radioKm, DEFAULT_ENGINE_CONFIG.radioKm),
    multipedido: typeof saved.multipedido === "boolean" ? saved.multipedido : DEFAULT_ENGINE_CONFIG.multipedido,
  };
}

export async function getEngineConfig(): Promise<EngineConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, ENGINE_CONFIG_KEY));
  return normalizeEngineConfig(row?.value);
}
