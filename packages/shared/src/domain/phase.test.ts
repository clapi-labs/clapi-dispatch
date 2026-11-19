import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  customerWaitEndsAt,
  goingReminderAt,
  isBeforePickup,
  isTripOpen,
  orderStops,
  PHASE_LABEL,
  phaseAlertAt,
  phaseSince,
  pickupLateAt,
  stopsForPhase,
  tripPhase,
  type PhaseInput,
  type PhaseTimes,
  type RouteStop,
  type TripPhase,
} from "./phase";

const MIN = 60_000;
const t0 = new Date("2026-11-10T15:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * MIN);

const cfg: PhaseTimes = {
  seenReminderMinutes: 3,
  seenAlertMinutes: 8,
  readyLeadMinutes: 5,
  pickupLateMinutes: 10,
  deliveryAlertMinutes: 30,
  returnAlertMinutes: 20,
  customerWaitMinutes: 7,
};

const trip = (over: Partial<PhaseInput> = {}): PhaseInput => ({ status: "assigned", assignedAt: at(0), ...over });

describe("tripPhase", () => {
  it("cancelled y pending mandan sobre cualquier hora", () => {
    assert.equal(tripPhase(trip({ status: "cancelled", pickedUpAt: at(5), deliveredAt: at(9) })), "cancelled");
    assert.equal(tripPhase(trip({ status: "pending", seenAt: at(1), pickedUpAt: at(5) })), "pending");
  });

  it("assigned sin nada más: unread", () => {
    assert.equal(tripPhase(trip()), "unread");
    assert.equal(tripPhase(trip({ status: "en_route" })), "unread");
  });

  it("read cuando solo se leyó", () => {
    assert.equal(tripPhase(trip({ readAt: at(1) })), "read");
  });

  it("going cuando marcó «Voy en camino»", () => {
    assert.equal(tripPhase(trip({ readAt: at(1), seenAt: at(2) })), "going");
  });

  it("going aunque no haya readAt (se salta un paso)", () => {
    assert.equal(tripPhase(trip({ seenAt: at(2) })), "going");
  });

  it("at_pickup manda sobre going y read", () => {
    assert.equal(tripPhase(trip({ readAt: at(1), seenAt: at(2), atPickupAt: at(3) })), "at_pickup");
    assert.equal(tripPhase(trip({ atPickupAt: at(3) })), "at_pickup");
  });

  it("carrying cuando ya recogió", () => {
    assert.equal(tripPhase(trip({ atPickupAt: at(3), pickedUpAt: at(4) })), "carrying");
    assert.equal(tripPhase(trip({ pickedUpAt: at(4) })), "carrying");
  });

  it("at_delivery solo si llegó y no se ha ido", () => {
    assert.equal(tripPhase(trip({ pickedUpAt: at(4), atDeliveryAt: at(10) })), "at_delivery");
    assert.equal(tripPhase(trip({ pickedUpAt: at(4), atDeliveryAt: at(10), leftDeliveryAt: at(12) })), "carrying");
  });

  it("atDeliveryAt sin pickedUpAt no cuenta como at_delivery", () => {
    assert.equal(tripPhase(trip({ atPickupAt: at(3), atDeliveryAt: at(10) })), "at_pickup");
    assert.equal(tripPhase(trip({ atDeliveryAt: at(10) })), "unread");
  });

  it("waiting_customer manda sobre las fases de recogido", () => {
    assert.equal(tripPhase(trip({ pickedUpAt: at(4), atDeliveryAt: at(10), customerWaitAt: at(11) })), "waiting_customer");
    assert.equal(tripPhase(trip({ customerWaitAt: at(11) })), "waiting_customer");
  });

  it("undelivered manda sobre waiting_customer", () => {
    assert.equal(tripPhase(trip({ pickedUpAt: at(4), customerWaitAt: at(11), undeliveredAt: at(20) })), "undelivered");
  });

  it("delivered", () => {
    assert.equal(tripPhase(trip({ status: "delivered", deliveredAt: at(30), deliveryPlace: "customer" })), "delivered");
    assert.equal(tripPhase(trip({ status: "delivered", deliveredAt: at(30) })), "delivered");
    assert.equal(tripPhase(trip({ status: "delivered", deliveredAt: at(30), deliveryPlace: null })), "delivered");
  });

  it("gate cuando se entregó en portería", () => {
    assert.equal(tripPhase(trip({ status: "delivered", deliveredAt: at(30), deliveryPlace: "gate" })), "gate");
  });

  it("delivered manda sobre undelivered y customerWaitAt", () => {
    assert.equal(tripPhase(trip({ status: "delivered", undeliveredAt: at(20), customerWaitAt: at(11), deliveredAt: at(30) })), "delivered");
  });

  it("deliveryPlace gate sin status delivered no da gate", () => {
    assert.equal(tripPhase(trip({ deliveryPlace: "gate", pickedUpAt: at(4) })), "carrying");
  });

  it("timestamps desordenados: manda el paso más avanzado, no el más reciente", () => {
    // seenAt posterior a pickedUpAt (reloj del celular, marcas tardías)
    assert.equal(tripPhase(trip({ seenAt: at(9), atPickupAt: at(8), pickedUpAt: at(2) })), "carrying");
    assert.equal(tripPhase(trip({ readAt: at(9), seenAt: at(1) })), "going");
  });

  it("acepta fechas como string ISO", () => {
    assert.equal(tripPhase(trip({ seenAt: at(1).toISOString() })), "going");
  });

  it("null y undefined cuentan como ausentes", () => {
    assert.equal(tripPhase(trip({ readAt: null, seenAt: undefined, atPickupAt: null })), "unread");
  });

  it("cubre los 12 estados", () => {
    const got = new Set<TripPhase>([
      tripPhase(trip({ status: "pending" })),
      tripPhase(trip()),
      tripPhase(trip({ readAt: at(1) })),
      tripPhase(trip({ seenAt: at(1) })),
      tripPhase(trip({ atPickupAt: at(1) })),
      tripPhase(trip({ pickedUpAt: at(1) })),
      tripPhase(trip({ pickedUpAt: at(1), atDeliveryAt: at(2) })),
      tripPhase(trip({ customerWaitAt: at(2) })),
      tripPhase(trip({ undeliveredAt: at(2) })),
      tripPhase(trip({ status: "delivered" })),
      tripPhase(trip({ status: "delivered", deliveryPlace: "gate" })),
      tripPhase(trip({ status: "cancelled" })),
    ]);
    assert.deepEqual([...got].sort(), Object.keys(PHASE_LABEL).sort());
    assert.equal(got.size, 12);
  });
});

describe("isTripOpen", () => {
  it("assigned y en_route dejan ocupado al motorizado", () => {
    assert.equal(isTripOpen({ status: "assigned" }), true);
    assert.equal(isTripOpen({ status: "en_route" }), true);
  });

  it("los demás estados no", () => {
    for (const status of ["pending", "delivered", "cancelled", "failed", ""]) {
      assert.equal(isTripOpen({ status }), false, status);
    }
  });
});

describe("isBeforePickup", () => {
  it("true antes de tener el pedido", () => {
    for (const p of ["unread", "read", "going", "at_pickup"] as TripPhase[]) assert.equal(isBeforePickup(p), true, p);
  });

  it("false desde que lo tiene o no aplica", () => {
    for (const p of ["pending", "carrying", "at_delivery", "waiting_customer", "undelivered", "delivered", "gate", "cancelled"] as TripPhase[]) {
      assert.equal(isBeforePickup(p), false, p);
    }
  });
});

describe("phaseSince", () => {
  const full = trip({
    readAt: at(1),
    seenAt: at(2),
    atPickupAt: at(3),
    pickedUpAt: at(4),
    atDeliveryAt: at(5),
    customerWaitAt: at(6),
    undeliveredAt: at(7),
    deliveredAt: at(8),
  });

  it("pending y cancelled no tienen desde cuándo", () => {
    assert.equal(phaseSince({ ...full, status: "pending" }), null);
    assert.equal(phaseSince({ ...full, status: "cancelled" }), null);
  });

  it("devuelve la hora de la marca de cada fase", () => {
    assert.deepEqual(phaseSince(trip()), at(0));
    assert.deepEqual(phaseSince(trip({ readAt: at(1) })), at(1));
    assert.deepEqual(phaseSince(trip({ readAt: at(1), seenAt: at(2) })), at(2));
    assert.deepEqual(phaseSince(trip({ atPickupAt: at(3) })), at(3));
    assert.deepEqual(phaseSince(trip({ pickedUpAt: at(4) })), at(4));
    assert.deepEqual(phaseSince(trip({ pickedUpAt: at(4), atDeliveryAt: at(5) })), at(5));
    assert.deepEqual(phaseSince(trip({ customerWaitAt: at(6) })), at(6));
    assert.deepEqual(phaseSince(trip({ customerWaitAt: at(6), undeliveredAt: at(7) })), at(7));
    assert.deepEqual(phaseSince(trip({ status: "delivered", deliveredAt: at(8) })), at(8));
    assert.deepEqual(phaseSince(trip({ status: "delivered", deliveredAt: at(8), deliveryPlace: "gate" })), at(8));
  });

  it("null si falta la marca de la fase", () => {
    assert.equal(phaseSince({ status: "assigned" }), null);
    assert.equal(phaseSince(trip({ status: "delivered" })), null);
  });

  it("convierte strings ISO a Date", () => {
    const got = phaseSince(trip({ seenAt: at(2).toISOString() }));
    assert.ok(got instanceof Date);
    assert.equal(got.getTime(), at(2).getTime());
  });

  it("devuelve una copia, no la misma instancia", () => {
    const d = at(1);
    assert.notEqual(phaseSince(trip({ readAt: d })), d);
  });
});

describe("goingReminderAt", () => {
  it("sin readyAt: asignación + recordatorio", () => {
    assert.deepEqual(goingReminderAt({ assignedAt: at(0) }, cfg), at(3));
    assert.deepEqual(goingReminderAt({ assignedAt: at(0), readyAt: null }, cfg), at(3));
  });

  it("comida lista pronto: manda el recordatorio", () => {
    // readyAt - lead = 6 - 5 = 1 < 3
    assert.deepEqual(goingReminderAt({ assignedAt: at(0), readyAt: at(6) }, cfg), at(3));
  });

  it("comida lista lejos: espera hasta readyAt - lead", () => {
    assert.deepEqual(goingReminderAt({ assignedAt: at(0), readyAt: at(20) }, cfg), at(15));
  });

  it("empate exacto", () => {
    assert.deepEqual(goingReminderAt({ assignedAt: at(0), readyAt: at(8) }, cfg), at(3));
  });

  it("acepta strings", () => {
    assert.deepEqual(goingReminderAt({ assignedAt: at(0).toISOString(), readyAt: at(20).toISOString() }, cfg), at(15));
  });

  it("assignedAt nulo cuenta como 0 (epoch)", () => {
    assert.equal(goingReminderAt({ assignedAt: null }, cfg).getTime(), 3 * MIN);
  });
});

describe("pickupLateAt", () => {
  it("sin readyAt cae a assignedAt", () => {
    assert.deepEqual(pickupLateAt({ assignedAt: at(0) }, cfg), at(10));
    assert.deepEqual(pickupLateAt({ assignedAt: at(0), readyAt: null }, cfg), at(10));
  });

  it("readyAt posterior a la asignación manda", () => {
    assert.deepEqual(pickupLateAt({ assignedAt: at(0), readyAt: at(15) }, cfg), at(25));
  });

  it("asignado después de que la comida estaba lista: cuenta desde la asignación", () => {
    assert.deepEqual(pickupLateAt({ assignedAt: at(30), readyAt: at(5) }, cfg), at(40));
  });

  it("acepta strings", () => {
    assert.deepEqual(pickupLateAt({ assignedAt: at(0).toISOString(), readyAt: at(15).toISOString() }, cfg), at(25));
  });
});

describe("customerWaitEndsAt", () => {
  it("customerWaitAt + minutos de espera", () => {
    assert.deepEqual(customerWaitEndsAt({ customerWaitAt: at(11) }, cfg), at(18));
  });

  it("acepta strings y respeta otra configuración", () => {
    assert.deepEqual(customerWaitEndsAt({ customerWaitAt: at(0).toISOString() }, { customerWaitMinutes: 15 }), at(15));
  });

  it("nulo cuenta como epoch", () => {
    assert.equal(customerWaitEndsAt({ customerWaitAt: null }, cfg).getTime(), 7 * MIN);
  });
});

describe("phaseAlertAt", () => {
  it("pending, cancelled, delivered y gate no tienen alerta", () => {
    assert.equal(phaseAlertAt(trip({ status: "pending" }), cfg), null);
    assert.equal(phaseAlertAt(trip({ status: "cancelled" }), cfg), null);
    assert.equal(phaseAlertAt(trip({ status: "delivered", deliveredAt: at(30) }), cfg), null);
    assert.equal(phaseAlertAt(trip({ status: "delivered", deliveredAt: at(30), deliveryPlace: "gate" }), cfg), null);
  });

  it("unread y read: recordatorio + (alerta - recordatorio)", () => {
    // 3 + (8 - 3) = 8 minutos desde la asignación
    assert.deepEqual(phaseAlertAt(trip(), cfg), at(8));
    assert.deepEqual(phaseAlertAt(trip({ readAt: at(1) }), cfg), at(8));
  });

  it("unread con readyAt lejano: se corre con el recordatorio", () => {
    assert.deepEqual(phaseAlertAt({ ...trip(), readyAt: at(20) }, cfg), at(20));
  });

  it("seenAlertMinutes menor que el recordatorio no adelanta la alerta", () => {
    assert.deepEqual(phaseAlertAt(trip(), { ...cfg, seenAlertMinutes: 1 }), at(3));
  });

  it("going y at_pickup: pickupLateAt", () => {
    assert.deepEqual(phaseAlertAt(trip({ seenAt: at(2) }), cfg), at(10));
    assert.deepEqual(phaseAlertAt(trip({ atPickupAt: at(4) }), cfg), at(10));
    assert.deepEqual(phaseAlertAt({ ...trip({ seenAt: at(2) }), readyAt: at(15) }, cfg), at(25));
  });

  it("carrying: pickedUpAt + deliveryAlertMinutes", () => {
    assert.deepEqual(phaseAlertAt(trip({ pickedUpAt: at(4) }), cfg), at(34));
  });

  it("carrying que ya salió del punto de entrega: alerta de una vez", () => {
    assert.deepEqual(phaseAlertAt(trip({ pickedUpAt: at(4), atDeliveryAt: at(10), leftDeliveryAt: at(12) }), cfg), at(12));
  });

  it("at_delivery: cuenta desde pickedUpAt", () => {
    assert.deepEqual(phaseAlertAt(trip({ pickedUpAt: at(4), atDeliveryAt: at(10) }), cfg), at(34));
  });

  it("waiting_customer: customerWaitEndsAt", () => {
    assert.deepEqual(phaseAlertAt(trip({ pickedUpAt: at(4), customerWaitAt: at(11) }), cfg), at(18));
  });

  it("undelivered: undeliveredAt + returnAlertMinutes", () => {
    assert.deepEqual(phaseAlertAt(trip({ pickedUpAt: at(4), undeliveredAt: at(20) }), cfg), at(40));
  });

  it("notNext anula la alerta antes de recoger la parada (unread, read, going)", () => {
    assert.equal(phaseAlertAt(trip(), cfg, { notNext: true }), null);
    assert.equal(phaseAlertAt(trip({ readAt: at(1) }), cfg, { notNext: true }), null);
    assert.equal(phaseAlertAt(trip({ seenAt: at(2) }), cfg, { notNext: true }), null);
  });

  it("notNext no afecta at_pickup ni las fases posteriores", () => {
    assert.deepEqual(phaseAlertAt(trip({ atPickupAt: at(4) }), cfg, { notNext: true }), at(10));
    assert.deepEqual(phaseAlertAt(trip({ pickedUpAt: at(4) }), cfg, { notNext: true }), at(34));
    assert.deepEqual(phaseAlertAt(trip({ customerWaitAt: at(11) }), cfg, { notNext: true }), at(18));
    assert.deepEqual(phaseAlertAt(trip({ undeliveredAt: at(20) }), cfg, { notNext: true }), at(40));
  });

  it("notNext en false explícito se comporta como el valor por defecto", () => {
    assert.deepEqual(phaseAlertAt(trip(), cfg, { notNext: false }), at(8));
  });
});

describe("stopsForPhase", () => {
  it("sin recoger: recoger y entregar", () => {
    for (const p of ["unread", "read", "going", "at_pickup"] as TripPhase[]) assert.deepEqual(stopsForPhase(p), ["R", "C"], p);
  });

  it("recogido: solo entregar", () => {
    assert.deepEqual(stopsForPhase("carrying"), ["C"]);
    assert.deepEqual(stopsForPhase("at_delivery"), ["C"]);
  });

  it("cliente no contesta: esperar y devolver", () => {
    assert.deepEqual(stopsForPhase("waiting_customer"), ["W", "V"]);
  });

  it("no entregado: devolver", () => {
    assert.deepEqual(stopsForPhase("undelivered"), ["V"]);
  });

  it("sin paradas en pending, delivered, gate y cancelled", () => {
    for (const p of ["pending", "delivered", "gate", "cancelled"] as TripPhase[]) assert.deepEqual(stopsForPhase(p), [], p);
  });

  it("devuelve un arreglo nuevo en cada llamada", () => {
    const a = stopsForPhase("going");
    a.push("B");
    assert.deepEqual(stopsForPhase("going"), ["R", "C"]);
  });
});

describe("orderStops", () => {
  const s = (tipo: RouteStop["tipo"], pedido: number): RouteStop => ({ tipo, pedido });

  it("sin viajes: vacío", () => {
    assert.deepEqual(orderStops(null, []), []);
    assert.deepEqual(orderStops([s("R", 1)], []), []);
  });

  it("sin plan (null/undefined/vacío): orden de trips", () => {
    const trips = [
      { id: 1, stops: ["R", "C"] as const },
      { id: 2, stops: ["C"] as const },
    ].map((t) => ({ id: t.id, stops: [...t.stops] }));
    const expected = [s("R", 1), s("C", 1), s("C", 2)];
    assert.deepEqual(orderStops(null, trips), expected);
    assert.deepEqual(orderStops(undefined, trips), expected);
    assert.deepEqual(orderStops([], trips), expected);
  });

  it("viajes sin recoger: respeta el plan", () => {
    const plan = [s("R", 2), s("R", 1), s("C", 1), s("C", 2)];
    const trips = [
      { id: 1, stops: stopsForPhase("unread") },
      { id: 2, stops: stopsForPhase("going") },
    ];
    assert.deepEqual(orderStops(plan, trips), plan);
  });

  it("lo ya hecho sale del resultado aunque siga en el plan", () => {
    const plan = [s("R", 1), s("C", 1), s("C", 2)];
    const trips = [
      { id: 1, stops: stopsForPhase("carrying") }, // ya recogió: solo C
      { id: 2, stops: stopsForPhase("carrying") },
    ];
    assert.deepEqual(orderStops(plan, trips), [s("C", 1), s("C", 2)]);
  });

  it("viajes recogidos: solo entregas, en orden del plan", () => {
    const plan = [s("C", 3), s("C", 1)];
    const trips = [
      { id: 1, stops: stopsForPhase("carrying") },
      { id: 3, stops: stopsForPhase("at_delivery") },
    ];
    assert.deepEqual(orderStops(plan, trips), [s("C", 3), s("C", 1)]);
  });

  it("lo que el plan no conoce va al final, en el orden de trips", () => {
    const plan = [s("C", 2)];
    const trips = [
      { id: 1, stops: ["R", "C"] as RouteStop["tipo"][] },
      { id: 2, stops: ["C"] as RouteStop["tipo"][] },
      { id: 3, stops: ["R", "C"] as RouteStop["tipo"][] },
    ];
    assert.deepEqual(orderStops(plan, trips), [s("C", 2), s("R", 1), s("C", 1), s("R", 3), s("C", 3)]);
  });

  it("devolución: V va primero aunque el plan la ponga al final", () => {
    const plan = [s("C", 2), s("R", 3), s("V", 1)];
    const trips = [
      { id: 1, stops: stopsForPhase("undelivered") },
      { id: 2, stops: stopsForPhase("carrying") },
      { id: 3, stops: stopsForPhase("read") },
    ];
    assert.deepEqual(orderStops(plan, trips), [s("V", 1), s("C", 2), s("R", 3), s("C", 3)]);
  });

  it("cliente que no contesta: W y V pasan por delante de lo demás", () => {
    const plan = [s("C", 2), s("W", 1), s("V", 1)];
    const trips = [
      { id: 2, stops: stopsForPhase("carrying") },
      { id: 1, stops: stopsForPhase("waiting_customer") },
    ];
    assert.deepEqual(orderStops(plan, trips), [s("W", 1), s("V", 1), s("C", 2)]);
  });

  it("entre urgentes también manda el plan", () => {
    const plan = [s("V", 2), s("W", 1)];
    const trips = [
      { id: 1, stops: stopsForPhase("waiting_customer") },
      { id: 2, stops: stopsForPhase("undelivered") },
    ];
    assert.deepEqual(orderStops(plan, trips), [s("V", 2), s("W", 1), s("V", 1)]);
  });

  it("parada B (regreso por un pendiente) es normal, no urgente", () => {
    const plan = [s("C", 1), s("B", 50), s("R", 2)];
    const trips = [
      { id: 1, stops: stopsForPhase("carrying") },
      { id: 2, stops: stopsForPhase("unread") },
      { id: 50, stops: ["B"] as RouteStop["tipo"][] },
    ];
    assert.deepEqual(orderStops(plan, trips), [s("C", 1), s("B", 50), s("R", 2), s("C", 2)]);
  });

  it("B que el plan no conocía queda al final", () => {
    const plan = [s("C", 1)];
    const trips = [
      { id: 7, stops: ["B"] as RouteStop["tipo"][] },
      { id: 1, stops: stopsForPhase("carrying") },
    ];
    assert.deepEqual(orderStops(plan, trips), [s("C", 1), s("B", 7)]);
  });

  it("el plan distingue tipo y pedido: mismo id con otro tipo no coincide", () => {
    const plan = [s("C", 1), s("R", 1)];
    const trips = [{ id: 1, stops: stopsForPhase("going") }];
    // el plan pone C antes que R: se respeta tal cual, sin reordenar por tipo
    assert.deepEqual(orderStops(plan, trips), [s("C", 1), s("R", 1)]);
  });

  it("viajes sin paradas (entregados, cancelados) no aportan", () => {
    const trips = [
      { id: 1, stops: stopsForPhase("delivered") },
      { id: 2, stops: stopsForPhase("cancelled") },
      { id: 3, stops: stopsForPhase("carrying") },
    ];
    assert.deepEqual(orderStops([s("C", 1), s("C", 3)], trips), [s("C", 3)]);
  });

  it("no modifica el plan ni los viajes recibidos", () => {
    const plan = [s("C", 2), s("R", 1)];
    const trips = [{ id: 1, stops: stopsForPhase("unread") }];
    const planCopy = structuredClone(plan);
    const tripsCopy = structuredClone(trips);
    orderStops(plan, trips);
    assert.deepEqual(plan, planCopy);
    assert.deepEqual(trips, tripsCopy);
  });
});
