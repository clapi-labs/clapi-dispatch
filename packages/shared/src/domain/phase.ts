/**
 * En qué va cada servicio (docs/FLUJO-DOMICILIARIO.md). Sale de las horas que
 * guarda la asignación, no de una columna aparte: así no se puede desfasar de
 * lo que de verdad pasó. Pura y sin base: la usan el bot y el tablero, y por
 * eso el recordatorio y la alerta del portal cuentan lo mismo.
 */

export type DeliveryPlace = "customer" | "gate";

export type TripPhase =
  | "pending"
  | "unread"
  | "read"
  | "going"
  | "at_pickup"
  | "carrying"
  | "at_delivery"
  | "waiting_customer"
  | "undelivered"
  | "returning"
  | "delivered"
  | "gate"
  | "cancelled";

/** Se dice «recogida» y no «restaurante»: no todo se recoge en uno. */
export const PHASE_LABEL: Record<TripPhase, string> = {
  pending: "Por asignar",
  unread: "Sin leer",
  read: "Leído",
  going: "Va a recoger",
  at_pickup: "En punto de recogida",
  carrying: "Llevando el pedido",
  at_delivery: "En punto de entrega",
  waiting_customer: "Cliente no contesta",
  undelivered: "Devolviendo el pedido",
  returning: "Volviendo a recogida",
  delivered: "Entregado",
  gate: "En portería",
  cancelled: "Cancelado",
};

type Time = Date | string | null | undefined;

export type PhaseInput = {
  status: string;
  assignedAt?: Time;
  readAt?: Time;
  seenAt?: Time;
  atPickupAt?: Time;
  pickedUpAt?: Time;
  atDeliveryAt?: Time;
  leftDeliveryAt?: Time;
  customerWaitAt?: Time;
  undeliveredAt?: Time;
  deliveredAt?: Time;
  deliveryPlace?: DeliveryPlace | null;
  returnStartedAt?: Time;
  finishedAt?: Time;
};

/** Los pasos se pueden saltar: marcar la entrega cuenta como recogido y «Recogí»
 *  como «Voy en camino», así que manda el paso más avanzado. */
export function tripPhase(t: PhaseInput): TripPhase {
  if (t.status === "cancelled") return "cancelled";
  if (t.status === "pending") return "pending";
  if (t.status === "delivered") {
    if (t.returnStartedAt && !t.finishedAt) return "returning";
    return t.deliveryPlace === "gate" ? "gate" : "delivered";
  }
  if (t.undeliveredAt) return "undelivered";
  if (t.customerWaitAt) return "waiting_customer";
  if (t.pickedUpAt) return t.atDeliveryAt && !t.leftDeliveryAt ? "at_delivery" : "carrying";
  if (t.atPickupAt) return "at_pickup";
  if (t.seenAt) return "going";
  return t.readAt ? "read" : "unread";
}

/** Con un viaje así, el motorizado sigue ocupado. */
export function isTripOpen(t: PhaseInput) {
  return t.status === "assigned" || t.status === "en_route" || tripPhase(t) === "returning";
}

/** Todavía no tiene el pedido en la mano. */
export function isBeforePickup(phase: TripPhase) {
  return phase === "unread" || phase === "read" || phase === "going" || phase === "at_pickup";
}

const ms = (t: Time) => (t ? new Date(t).getTime() : null);

/** Desde cuándo está en ese estado. */
export function phaseSince(t: PhaseInput): Date | null {
  const since: Record<TripPhase, Time> = {
    pending: null,
    cancelled: null,
    unread: t.assignedAt,
    read: t.readAt,
    going: t.seenAt,
    at_pickup: t.atPickupAt,
    carrying: t.pickedUpAt,
    at_delivery: t.atDeliveryAt,
    waiting_customer: t.customerWaitAt,
    undelivered: t.undeliveredAt,
    returning: t.returnStartedAt,
    delivered: t.deliveredAt,
    gate: t.deliveredAt,
  };
  const time = ms(since[tripPhase(t)]);
  return time === null ? null : new Date(time);
}

export type PhaseTimes = {
  seenReminderMinutes: number;
  seenAlertMinutes: number;
  readyLeadMinutes: number;
  pickupLateMinutes: number;
  deliveryAlertMinutes: number;
  returnAlertMinutes: number;
  customerWaitMinutes: number;
};

const MINUTE = 60_000;

/** Cuándo recordarle «Voy en camino»: unos minutos después de asignar, pero no
 *  mientras falte mucho para que la comida esté lista. */
export function goingReminderAt(t: { assignedAt: Time; readyAt?: Time }, c: PhaseTimes): Date {
  const assigned = ms(t.assignedAt) ?? 0;
  const ready = ms(t.readyAt);
  return new Date(Math.max(assigned + c.seenReminderMinutes * MINUTE, ready === null ? 0 : ready - c.readyLeadMinutes * MINUTE));
}

/** Cuándo avisar que ya debería haber recogido. Si se asignó tarde, se cuenta
 *  desde la asignación: antes no tenía cómo. */
export function pickupLateAt(t: { assignedAt: Time; readyAt?: Time }, c: PhaseTimes): Date {
  const assigned = ms(t.assignedAt) ?? 0;
  return new Date(Math.max(assigned, ms(t.readyAt) ?? 0) + c.pickupLateMinutes * MINUTE);
}

/** Cuándo se acaba la espera a un cliente que no contesta. */
export function customerWaitEndsAt(t: { customerWaitAt: Time }, c: Pick<PhaseTimes, "customerWaitMinutes">): Date {
  return new Date((ms(t.customerWaitAt) ?? 0) + c.customerWaitMinutes * MINUTE);
}

/**
 * Desde cuándo el tablero lo marca en rojo; `null` si no hay nada que vigilar.
 * `notNext`: tiene otras paradas antes de esta recogida, así que no ir todavía
 * no es una demora.
 */
export function phaseAlertAt(t: PhaseInput & { readyAt?: Time }, c: PhaseTimes, { notNext = false } = {}): Date | null {
  const phase = tripPhase(t);
  if (notNext && (phase === "unread" || phase === "read" || phase === "going")) return null;
  switch (phase) {
    case "unread":
    case "read":
      return new Date(goingReminderAt({ assignedAt: t.assignedAt, readyAt: t.readyAt }, c).getTime() + Math.max(0, c.seenAlertMinutes - c.seenReminderMinutes) * MINUTE);
    case "going":
    case "at_pickup":
      return pickupLateAt({ assignedAt: t.assignedAt, readyAt: t.readyAt }, c);
    case "carrying":
      // Se fue del punto de entrega sin marcarla: de una vez.
      if (t.leftDeliveryAt) return new Date(ms(t.leftDeliveryAt) ?? 0);
      return new Date((ms(t.pickedUpAt) ?? 0) + c.deliveryAlertMinutes * MINUTE);
    case "at_delivery":
      return new Date((ms(t.pickedUpAt) ?? ms(t.atDeliveryAt) ?? 0) + c.deliveryAlertMinutes * MINUTE);
    case "waiting_customer":
      return customerWaitEndsAt({ customerWaitAt: t.customerWaitAt }, c);
    case "undelivered":
      return new Date((ms(t.undeliveredAt) ?? 0) + c.returnAlertMinutes * MINUTE);
    case "returning":
      return new Date((ms(t.returnStartedAt) ?? 0) + c.returnAlertMinutes * MINUTE);
    default:
      return null;
  }
}

/**
 * Las paradas: `R` recoger, `C` entregar, `W` esperar a un cliente que no
 * contesta, `V` devolver un pedido no entregado, `B` volver a recogida después
 * de entregar. Se guarda solo el orden (`courier_routes`): qué le falta de cada
 * viaje sale de su fase.
 */
export type StopKind = "R" | "C" | "W" | "V" | "B";
export type RouteStop = { tipo: StopKind; pedido: number };

/** Lo que le falta de un viaje. Si tendrá que volver solo se sabe al entregar:
 *  con `assumeReturn` se cuenta el peor caso. */
export function stopsForPhase(phase: TripPhase, assumeReturn: boolean): StopKind[] {
  const after: StopKind[] = assumeReturn ? ["C", "B"] : ["C"];
  switch (phase) {
    case "returning":
      return ["B"];
    case "undelivered":
      return ["V"];
    case "waiting_customer":
      return ["W", "V"];
    case "carrying":
    case "at_delivery":
      return after;
    case "unread":
    case "read":
    case "going":
    case "at_pickup":
      return ["R", ...after];
    default:
      return [];
  }
}

/**
 * Las paradas pendientes en orden: el del último plan, con lo ya hecho afuera y
 * al final lo que el plan no conocía (un viaje asignado a mano, por ejemplo). La
 * espera a un cliente va primero: mientras tanto no puede ir a otro lado.
 */
export function orderStops(plan: RouteStop[] | null | undefined, trips: { id: number; stops: StopKind[] }[]): RouteStop[] {
  const pending = trips.flatMap((t) => t.stops.map((tipo) => ({ tipo, pedido: t.id })));
  const position = (s: RouteStop) => {
    const i = plan?.findIndex((p) => p.tipo === s.tipo && p.pedido === s.pedido) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const urgent = (s: RouteStop) => (s.tipo === "W" || s.tipo === "V" ? 0 : 1);
  // `sort` es estable: lo que el plan no conoce queda en el orden de `trips`.
  return pending.sort((a, b) => urgent(a) - urgent(b) || position(a) - position(b));
}
