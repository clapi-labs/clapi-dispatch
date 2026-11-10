/**
 * La señal de GPS de una moto (docs/FLUJO-DOMICILIARIO.md, «Fase 5»). El
 * celular reporta más o menos cada 10 segundos; si pasan `NO_SIGNAL_MS` sin un
 * reporte, la moto queda «sin señal»: el portal lo muestra con la hora de su
 * última posición y el algoritmo no la elige. Vuelve sola a «en vivo» con el
 * siguiente reporte.
 *
 * Es la única definición: la usan el bot, el algoritmo y el portal.
 */

export const NO_SIGNAL_MS = 30_000;

/** No se guarda el recorrido: una posición se borra a las 24 horas. */
export const POSITION_RETENTION_MS = 24 * 60 * 60_000;

/**
 * Diferencia entre el reloj del celular y el del servidor que se pasa por alto.
 * Con un límite de 30 segundos, un celular unos segundos atrasado haría parpadear
 * a la moto entre «en vivo» y «sin señal».
 */
export const CLOCK_TOLERANCE_MS = 60_000;

/** `live`: reportó hace menos de `NO_SIGNAL_MS`. `lost`: tiene una posición,
 *  pero vieja. `none`: nunca reportó (o su posición ya se borró). */
export type SignalState = "live" | "lost" | "none";

type Located = { lat: number | null; lng: number | null; locationUpdatedAt: Date | string | null };

const time = (value: Date | string) => (typeof value === "string" ? Date.parse(value) : value.getTime());

export function signalState(courier: Located, now: Date | number = Date.now()): SignalState {
  if (courier.lat == null || courier.lng == null || !courier.locationUpdatedAt) return "none";
  const at = time(courier.locationUpdatedAt);
  if (!Number.isFinite(at)) return "none";
  const nowMs = typeof now === "number" ? now : now.getTime();
  return nowMs - at < NO_SIGNAL_MS ? "live" : "lost";
}

export function hasSignal(courier: Located, now: Date | number = Date.now()): boolean {
  return signalState(courier, now) === "live";
}

/**
 * La hora con la que se guarda una posición. Si el reloj del celular está cerca
 * del del servidor, vale la hora del servidor, así el atraso del reloj no cuenta
 * como falta de señal. Un reporte adelantado tampoco deja la moto «en vivo» de
 * más. Un reporte muy anterior es uno que el celular guardó sin conexión y envía
 * tarde: conserva su hora, porque esa posición ya es vieja.
 */
export function positionTime(reported: Date, now: Date): Date {
  const behind = now.getTime() - reported.getTime();
  return behind > CLOCK_TOLERANCE_MS ? reported : now;
}
