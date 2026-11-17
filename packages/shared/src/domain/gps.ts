/**
 * La señal de GPS de una moto (docs/FLUJO-DOMICILIARIO.md, «Fase 5»). En
 * movimiento, el celular reporta más o menos cada 10 segundos; si pasan
 * `NO_SIGNAL_MS` sin reporte queda «sin señal». Quieto, Traccar Client manda
 * un heartbeat cada ~60–105 s (ahorro de batería en Android): por eso una
 * moto que reportó estar quieta (`locationMoving === false`) pasa a «quieto»
 * entre `NO_SIGNAL_MS` y `STILL_NO_SIGNAL_MS` (sigue válida para asignar) y
 * solo cae a «sin señal» si pasa `STILL_NO_SIGNAL_MS` sin heartbeat.
 *
 * Es la única definición: la usan el bot, el algoritmo y el portal.
 */

export const NO_SIGNAL_MS = 30_000;

/** Con la moto quieta (`locationMoving === false`), margen para el stationary
 *  heartbeat de Traccar Client (60 s nominales, ~105 s reales en Android) antes
 *  de darla por «sin señal» cuando se apagan los datos o se cierra la app. */
export const STILL_NO_SIGNAL_MS = 3 * 60_000;

/** No se guarda el recorrido: una posición se borra a las 24 horas. */
export const POSITION_RETENTION_MS = 24 * 60 * 60_000;

/**
 * Diferencia entre el reloj del celular y el del servidor que se pasa por alto.
 * Con un límite de 30 segundos, un celular unos segundos atrasado haría parpadear
 * a la moto entre «en vivo» y «sin señal».
 */
export const CLOCK_TOLERANCE_MS = 60_000;

/**
 * - `live`: reportó hace menos de `NO_SIGNAL_MS`.
 * - `still`: reportó estar quieta y su último heartbeat fue hace menos de `STILL_NO_SIGNAL_MS` (válida para el algoritmo).
 * - `lost`: tiene una posición, pero superó el tiempo límite sin reportar.
 * - `none`: nunca reportó (o su posición ya se borró).
 */
export type SignalState = "live" | "still" | "lost" | "none";

type Located = {
  lat: number | null;
  lng: number | null;
  locationUpdatedAt: Date | string | null;
  locationMoving?: boolean | null;
};

const time = (value: Date | string) => (typeof value === "string" ? Date.parse(value) : value.getTime());

export function signalState(courier: Located, now: Date | number = Date.now()): SignalState {
  if (courier.lat == null || courier.lng == null || !courier.locationUpdatedAt) return "none";
  const at = time(courier.locationUpdatedAt);
  if (!Number.isFinite(at)) return "none";
  const nowMs = typeof now === "number" ? now : now.getTime();
  const elapsed = nowMs - at;
  if (elapsed < NO_SIGNAL_MS) return "live";
  if (courier.locationMoving === false && elapsed < STILL_NO_SIGNAL_MS) return "still";
  return "lost";
}

export function hasSignal(courier: Located, now: Date | number = Date.now()): boolean {
  const state = signalState(courier, now);
  return state === "live" || state === "still";
}

/**
 * Mensaje de WhatsApp con los datos para configurar Traccar Client. Cada dato
 * va en su propia línea para que el domiciliario lo copie sin enredos desde su
 * chat.
 */
export function traccarConfigMessage(deviceId: string, serverUrl: string): string {
  return [
    "📍 Configura Traccar Client en tu celular con estos datos:",
    "",
    "Identificador del dispositivo:",
    deviceId,
    "",
    "URL del servidor:",
    serverUrl,
    "",
    "Ajustes en la app:",
    "Location accuracy: High",
    "Distance: Disabled",
    "Interval: 10",
    "Stationary heartbeat: 60",
    "Offline buffering: Activado",
    "Wake lock: Activado",
    "Stop detection: Desactivado",
    "Use system location: Desactivado",
    "",
    "Permisos del celular:",
    "Ubicación: Permitir todo el tiempo",
    "Batería: Sin restricciones",
    "Notificaciones: Activadas",
  ].join("\n");
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
