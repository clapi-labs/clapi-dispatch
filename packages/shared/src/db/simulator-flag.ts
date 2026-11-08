import { eq } from "drizzle-orm";

import { couriers } from "./schema";

/**
 * El simulador de staging (docs/OPERACION.md, «Simulador»). Todo depende de esta
 * variable, que solo existe en staging: sin ella no hay página, ni proceso de
 * movimiento, ni desvío de mensajes, y cada moto recibe en su propio número.
 */
export function simulatorEnabled(): boolean {
  const value = process.env.SIMULATOR_ENABLED;
  return value === "true" || value === "1";
}

/**
 * Las motos a las que el despacho puede asignar. Con el simulador, solo las
 * simuladas: una moto con número real es un número de prueba y no recibe
 * pedidos por sí misma. Sin él, nunca las simuladas, que no tienen a quién
 * escribirle.
 */
export const dispatchableCourier = () => eq(couriers.simulated, simulatorEnabled());
