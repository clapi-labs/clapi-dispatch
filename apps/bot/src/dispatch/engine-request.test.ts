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
const settings = { radioKm: 4, multipedido: true, asumirRegreso: true };

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
