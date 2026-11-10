import { and, eq, or, sql } from "drizzle-orm";

import { courierProfiles, couriers } from "./schema";

/**
 * El simulador de staging (docs/OPERACION.md, «Simulador»). Todo depende de esta
 * variable, que solo existe en staging: sin ella no hay página, ni proceso de
 * movimiento, ni desvío de mensajes, y cada moto recibe en su propio número.
 */
export function simulatorEnabled(): boolean {
  const value = process.env.SIMULATOR_ENABLED;
  return value === "true" || value === "1";
}

/** La moto tiene identificador de GPS: su celular reporta por `/api/gps`. */
export const hasGpsDevice = () =>
  sql<boolean>`exists (select 1 from ${courierProfiles} where ${courierProfiles.courierId} = ${couriers.id} and ${courierProfiles.gpsDeviceId} is not null)`;

/**
 * Con el simulador, una moto con número real puede ser dos cosas:
 * - **Número de prueba** (sin identificador de GPS): controla una moto simulada
 *   y no recibe pedidos por sí misma.
 * - **Moto real con GPS** (con identificador): reporta su ubicación de verdad,
 *   nunca controla una moto simulada y no recibe pedidos automáticos; solo un
 *   viaje de prueba que se le asigna a mano (issue #42).
 * Sin el simulador todas las motos con número real son motos reales.
 */
export const realGpsCourier = () => and(eq(couriers.simulated, false), hasGpsDevice());

/**
 * Las motos a las que el despacho (cola o engine) puede asignar solo. Con el
 * simulador, solo las simuladas: así las reales no reciben los pedidos del
 * simulador. Sin él, nunca las simuladas, que no tienen a quién escribirle.
 */
export const dispatchableCourier = () => eq(couriers.simulated, simulatorEnabled());

/** Las motos a las que la central puede asignar a mano: las del despacho y, con
 *  el simulador, también las reales con GPS, para un viaje de prueba. */
export const assignableByHand = () => (simulatorEnabled() ? or(dispatchableCourier(), realGpsCourier()) : dispatchableCourier());
