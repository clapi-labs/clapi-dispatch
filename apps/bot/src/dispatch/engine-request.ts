import { hasSignal, orderStops, stopsForPhase, type RouteStop, type StopKind, type TripPhase } from "@dispatch/shared";

/**
 * Arma la petición a `POST /evaluar` (contrato en docs/ALGORITMO.md) con lo
 * que hay en la base. Pura: sin red ni base, para poder probarla sola.
 *
 * Lo que la base todavía no tiene se aproxima, y se dice dónde:
 * - Sin la cuota 1/N del turno, la cuota es el promedio de entregas del grupo.
 */

type LatLng = { lat: number; lng: number };

export type SnapshotTrip = {
  id: number;
  pickupLocation: LatLng | null;
  deliveryLocation: LatLng | null;
  readyAt: Date | null;
};

/** Un viaje que el motorizado lleva encima: qué le falta depende de la fase. */
export type SnapshotActiveTrip = SnapshotTrip & { phase: TripPhase; customerWaitEndsAt: Date | null };

export type SnapshotCourier = {
  id: number;
  lat: number | null;
  lng: number | null;
  locationUpdatedAt: Date | null;
  deliveriesThisShift: number;
  shiftStartedAt: Date | null;
  lastDeliveredAt: Date | null;
  /** Los viajes que lleva, en el orden en que se le asignaron. */
  activeTrips: SnapshotActiveTrip[];
  /** El orden que dejó su última asignación. */
  route: RouteStop[] | null;
};

export type EngineSettings = { radioKm: number; multipedido: boolean; asumirRegreso: boolean };

type Parada = { tipo: StopKind; punto: [number, number]; pedido: number; listo_ts?: number };

export type EvaluarRequest = {
  ahora: number;
  modo: null;
  multipedido: boolean;
  radio_km: number;
  pedido: { id: number; restaurante: [number, number]; cliente: [number, number]; listo_ts: number };
  motos: {
    id: string;
    lat: number;
    lon: number;
    sin_senal: boolean;
    entregas: number;
    cuota: number;
    disponible_desde_ts: number;
    paradas: Parada[];
  }[];
  tiempos: "haversine";
};

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const point = ({ lat, lng }: LatLng): [number, number] => [lat, lng];

function paradasDe(c: SnapshotCourier, trips: SnapshotActiveTrip[], asumirRegreso: boolean): Parada[] {
  // Sin ubicación no se puede ubicar en la ruta.
  const located = trips.filter((t) => t.pickupLocation && (t.deliveryLocation || t.phase === "returning" || t.phase === "undelivered"));
  const stops = orderStops(
    c.route,
    located.map((t) => ({ id: t.id, stops: stopsForPhase(t.phase, asumirRegreso) })),
  );
  return stops.map(({ tipo, pedido }) => {
    const t = located.find((x) => x.id === pedido)!;
    const punto = point(tipo === "C" || tipo === "W" ? t.deliveryLocation! : t.pickupLocation!);
    if (tipo === "R" && t.readyAt) return { tipo, punto, pedido, listo_ts: seconds(t.readyAt) };
    if (tipo === "W" && t.customerWaitEndsAt) return { tipo, punto, pedido, listo_ts: seconds(t.customerWaitEndsAt) };
    return { tipo, punto, pedido };
  });
}

/**
 * La foto del momento para evaluar `trip`. Ese viaje se quita de la ruta de
 * todas las motos: en modo sombra la cola ya pudo haberlo asignado, y se
 * evalúa como si no.
 */
export function buildEvaluarRequest(
  trip: SnapshotTrip,
  couriers: SnapshotCourier[],
  now: Date,
  settings: EngineSettings,
): { ok: true; request: EvaluarRequest } | { ok: false; missing: string[] } {
  const missing = [
    !trip.pickupLocation && "ubicación del restaurante",
    !trip.deliveryLocation && "ubicación de la entrega",
    !trip.readyAt && "hora de listo",
  ].filter((m): m is string => Boolean(m));
  if (missing.length || !trip.pickupLocation || !trip.deliveryLocation || !trip.readyAt) return { ok: false, missing };

  // Sin reporte en los últimos 30 segundos (domain/gps.ts), el engine la excluye.
  const sinSenal = (c: SnapshotCourier) => !hasSignal(c, now);

  const conSenal = couriers.filter((c) => !sinSenal(c));
  const grupo = conSenal.length ? conSenal : couriers;
  const cuota = grupo.length ? grupo.reduce((sum, c) => sum + c.deliveriesThisShift, 0) / grupo.length : 0;

  return {
    ok: true,
    request: {
      ahora: seconds(now),
      modo: null, // el engine lo saca de la hora de Cali
      multipedido: settings.multipedido,
      radio_km: settings.radioKm,
      pedido: { id: trip.id, restaurante: point(trip.pickupLocation), cliente: point(trip.deliveryLocation), listo_ts: seconds(trip.readyAt) },
      motos: couriers.map((c) => {
        const desde = [c.lastDeliveredAt, c.shiftStartedAt].filter((d): d is Date => d !== null);
        return {
          id: String(c.id),
          // Sin posición se manda 0,0: igual queda excluida por `sin_senal`.
          lat: c.lat ?? 0,
          lon: c.lng ?? 0,
          sin_senal: sinSenal(c),
          entregas: c.deliveriesThisShift,
          cuota,
          disponible_desde_ts: desde.length ? Math.max(...desde.map(seconds)) : seconds(now),
          paradas: paradasDe(c, c.activeTrips.filter((t) => t.id !== trip.id), settings.asumirRegreso),
        };
      }),
      tiempos: "haversine",
    },
  };
}
