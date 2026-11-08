import { eq } from "drizzle-orm";

import { db } from "./client";
import { settings } from "./schema";

export const ENGINE_CONFIG_KEY = "engine_config";

/**
 * Cómo usa el despacho al engine (docs/ALGORITMO.md). Se cambia en la base,
 * sin redesplegar.
 */
export type EngineConfig = {
  /** `queue`: solo la cola. `shadow`: la cola asigna y el engine calcula al
   *  lado, guardando a quién habría asignado. `auto`: asigna el engine y la cola
   *  no se usa; si no hay GPS o el engine falla, los pedidos esperan y la central
   *  los asigna a mano. */
  mode: "queue" | "shadow" | "auto";
  /** Las motos más lejos que esto del restaurante no participan. */
  radioKm: number;
  /** Si una moto ocupada puede recibir otro pedido. */
  multipedido: boolean;
  /** Sin reporte de GPS en estos minutos, la moto cuenta como sin señal. */
  sinSenalMin: number;
  /** Contar que toda moto puede tener que volver a recogida después de
   *  entregar: solo se sabe al entregar, y es el peor caso para su ruta. */
  asumirRegreso: boolean;
};

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  mode: "shadow",
  radioKm: 4,
  multipedido: true,
  sinSenalMin: 2,
  asumirRegreso: true,
};

/** La configuración guardada, con los valores por defecto en lo que falte. */
export async function getEngineConfig(): Promise<EngineConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, ENGINE_CONFIG_KEY));
  const saved = (row?.value ?? {}) as Partial<EngineConfig>;
  const positive = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback);
  return {
    mode: saved.mode === "queue" || saved.mode === "shadow" || saved.mode === "auto" ? saved.mode : DEFAULT_ENGINE_CONFIG.mode,
    radioKm: positive(saved.radioKm, DEFAULT_ENGINE_CONFIG.radioKm),
    multipedido: typeof saved.multipedido === "boolean" ? saved.multipedido : DEFAULT_ENGINE_CONFIG.multipedido,
    sinSenalMin: positive(saved.sinSenalMin, DEFAULT_ENGINE_CONFIG.sinSenalMin),
    asumirRegreso: typeof saved.asumirRegreso === "boolean" ? saved.asumirRegreso : DEFAULT_ENGINE_CONFIG.asumirRegreso,
  };
}
