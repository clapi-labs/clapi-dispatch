import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildEvaluarRequest, type SnapshotCourier, type SnapshotTrip } from "./engine-request";

/**
 * Una moto sin señal no la elige el algoritmo (issue #42, criterio 4): el bot la
 * manda con `sin_senal: true` y el engine la excluye (apps/engine,
 * tests/test_contrato.py, «sin_senal»).
 */

const now = new Date("2026-11-10T15:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const settings = { radioKm: 4, multipedido: true, demanda: "baja" as const };

const trip: SnapshotTrip = {
  id: 1,
  pickupLocation: { lat: 3.4372, lng: -76.5225 },
  deliveryLocation: { lat: 3.45, lng: -76.53 },
  readyAt: new Date(now.getTime() + 10 * 60_000),
};

const moto = (id: number, locationUpdatedAt: Date | null, position = true): SnapshotCourier => ({
  id,
  lat: position ? 3.44 : null,
  lng: position ? -76.52 : null,
  locationUpdatedAt,
  deliveriesThisShift: 2,
  shiftStartedAt: ago(60 * 60_000),
  lastDeliveredAt: null,
  activeTrips: [],
  route: null,
});

function sinSenal(couriers: SnapshotCourier[]) {
  const built = buildEvaluarRequest(trip, couriers, now, settings);
  assert.ok(built.ok);
  return Object.fromEntries(built.request.motos.map((m) => [m.id, m.sin_senal]));
}

describe("buildEvaluarRequest: señal de GPS", () => {
  it("una moto que reportó hace menos de 30 segundos participa", () => {
    assert.deepEqual(sinSenal([moto(1, ago(0)), moto(2, ago(10_000)), moto(3, ago(29_000))]), { 1: false, 2: false, 3: false });
  });

  it("a los 30 segundos sin reporte queda sin señal y el engine no la elige", () => {
    assert.deepEqual(sinSenal([moto(1, ago(30_000)), moto(2, ago(31_000)), moto(3, ago(2 * 60_000))]), { 1: true, 2: true, 3: true });
  });

  it("sin posición, o sin hora de la posición, queda sin señal", () => {
    assert.deepEqual(sinSenal([moto(1, null), moto(2, ago(1000), false)]), { 1: true, 2: true });
  });

  it("vuelve a participar sola con el siguiente reporte", () => {
    assert.deepEqual(sinSenal([moto(1, ago(45_000))]), { 1: true });
    assert.deepEqual(sinSenal([moto(1, ago(2_000))]), { 1: false });
  });

  it("las motos sin señal no cuentan para la cuota del grupo", () => {
    const built = buildEvaluarRequest(trip, [{ ...moto(1, ago(1000)), deliveriesThisShift: 4 }, { ...moto(2, ago(60_000)), deliveriesThisShift: 0 }], now, settings);
    assert.ok(built.ok);
    assert.equal(built.request.motos[0].cuota, 4);
  });
});

describe("buildEvaluarRequest: interruptor de km por calle", () => {
  it("apagado (o sin definir) pide tiempos en línea recta, como siempre", () => {
    for (const s of [settings, { ...settings, porCalle: false }]) {
      const built = buildEvaluarRequest(trip, [moto(1, ago(0))], now, s);
      assert.ok(built.ok);
      assert.equal(built.request.tiempos, "haversine");
    }
  });

  it("encendido pide los tiempos por calle a OSRM; el resto de la petición no cambia", () => {
    const off = buildEvaluarRequest(trip, [moto(1, ago(0))], now, settings);
    const on = buildEvaluarRequest(trip, [moto(1, ago(0))], now, { ...settings, porCalle: true });
    assert.ok(off.ok && on.ok);
    assert.equal(on.request.tiempos, "osrm");
    assert.deepEqual({ ...on.request, tiempos: "haversine" }, off.request);
  });
});

describe("buildEvaluarRequest: sin regreso supuesto", () => {
  it("una moto que lleva un pedido solo tiene que entregarlo: no se le suma volver a recogida", () => {
    const llevando = { ...moto(1, ago(0)), activeTrips: [{ ...trip, id: 7, phase: "carrying" as const, customerWaitEndsAt: null }] };
    const built = buildEvaluarRequest(trip, [llevando], now, settings);
    assert.ok(built.ok);
    assert.deepEqual(
      built.request.motos[0].paradas.map((p) => `${p.tipo}${p.pedido}`),
      ["C7"],
    );
  });

  it("por recoger: recoger y entregar, sin regreso", () => {
    const porRecoger = { ...moto(1, ago(0)), activeTrips: [{ ...trip, id: 8, phase: "going" as const, customerWaitEndsAt: null }] };
    const built = buildEvaluarRequest(trip, [porRecoger], now, settings);
    assert.ok(built.ok);
    assert.deepEqual(
      built.request.motos[0].paradas.map((p) => p.tipo),
      ["R", "C"],
    );
  });
});

describe("buildEvaluarRequest: regresos al restaurante", () => {
  const lejos = { lat: 3.42, lng: -76.54 };
  const llevando = { ...trip, id: 7, restaurantId: 3, phase: "carrying" as const, customerWaitEndsAt: null };
  const datafono = { id: 40, reason: "datafono" as const, restaurantId: 3, inRoute: true, location: lejos };
  const plata = { id: 41, reason: "plata" as const, restaurantId: 5, inRoute: false, location: lejos };

  const paradas = (c: SnapshotCourier, demanda: "alta" | "baja") => {
    const built = buildEvaluarRequest(trip, [c], now, { ...settings, demanda });
    assert.ok(built.ok);
    return built.request.motos[0];
  };

  it("la demanda decide el modo y viaja en la petición", () => {
    for (const [demanda, modo] of [["alta", "pico"], ["baja", "valle"]] as const) {
      const built = buildEvaluarRequest(trip, [moto(1, ago(0))], now, { ...settings, demanda });
      assert.ok(built.ok);
      assert.equal(built.request.modo, modo);
      assert.equal(built.request.demanda, demanda);
    }
  });

  it("el datáfono va en la ruta, después de entregar lo que lleva, con su motivo y su restaurante", () => {
    const m = paradas({ ...moto(1, ago(0)), activeTrips: [llevando], returns: [datafono] }, "baja");
    assert.deepEqual(m.paradas.map((p) => `${p.tipo}${p.pedido}`), ["C7", "B40"]);
    assert.deepEqual(m.paradas[1], { tipo: "B", punto: [lejos.lat, lejos.lng], pedido: 40, motivo: "datafono", restaurante_id: 3 });
  });

  it("con demanda baja, el datáfono va antes de la siguiente recogida; con alta, al final", () => {
    const porRecoger = { ...trip, id: 8, phase: "going" as const, customerWaitEndsAt: null };
    const c = { ...moto(1, ago(0)), activeTrips: [llevando, porRecoger], returns: [datafono] };
    assert.deepEqual(paradas(c, "baja").paradas.map((p) => `${p.tipo}${p.pedido}`), ["C7", "B40", "R8", "C8"]);
    assert.deepEqual(paradas(c, "alta").paradas.map((p) => `${p.tipo}${p.pedido}`), ["C7", "R8", "C8", "B40"]);
  });

  it("la plata que no está en la ruta va aparte, solo para la ventaja del mismo restaurante", () => {
    const m = paradas({ ...moto(1, ago(0)), returns: [plata] }, "alta");
    assert.deepEqual(m.paradas, []);
    assert.deepEqual(m.pendientes, [{ pedido: 41, motivo: "plata", punto: [lejos.lat, lejos.lng], restaurante_id: 5 }]);
  });

  it("un regreso sin ubicación no se manda", () => {
    const m = paradas({ ...moto(1, ago(0)), returns: [{ ...datafono, location: null }, { ...plata, location: null }] }, "baja");
    assert.deepEqual(m.paradas, []);
    assert.deepEqual(m.pendientes, []);
  });

  it("el pedido y sus recogidas llevan el id del restaurante", () => {
    const built = buildEvaluarRequest({ ...trip, restaurantId: 9 }, [moto(1, ago(0))], now, settings);
    assert.ok(built.ok);
    assert.equal(built.request.pedido.restaurante_id, 9);
  });
});
