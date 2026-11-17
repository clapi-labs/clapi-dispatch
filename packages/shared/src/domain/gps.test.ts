import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasSignal, NO_SIGNAL_MS, positionTime, signalState, STILL_NO_SIGNAL_MS, traccarConfigMessage } from "./gps";

const now = new Date("2026-11-10T15:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const at = (locationUpdatedAt: Date | string | null, locationMoving?: boolean | null) => ({
  lat: 3.45,
  lng: -76.53,
  locationUpdatedAt,
  locationMoving,
});

describe("signalState", () => {
  it("en vivo si reportó hace menos de 30 segundos", () => {
    assert.equal(signalState(at(ago(0)), now), "live");
    assert.equal(signalState(at(ago(10_000)), now), "live");
    assert.equal(signalState(at(ago(NO_SIGNAL_MS - 1)), now), "live");
  });

  it("sin señal desde los 30 segundos sin reporte", () => {
    assert.equal(signalState(at(ago(NO_SIGNAL_MS)), now), "lost");
    assert.equal(signalState(at(ago(5 * 60_000)), now), "lost");
  });

  it("sin posición si nunca reportó o le falta un dato", () => {
    assert.equal(signalState(at(null), now), "none");
    assert.equal(signalState({ lat: null, lng: null, locationUpdatedAt: ago(1000) }, now), "none");
    assert.equal(signalState({ lat: 3.45, lng: null, locationUpdatedAt: ago(1000) }, now), "none");
  });

  it("acepta la hora como texto, como llega al portal", () => {
    assert.equal(signalState(at(ago(5_000).toISOString()), now), "live");
    assert.equal(signalState(at(ago(45_000).toISOString()), now.getTime()), "lost");
    assert.equal(signalState(at("no es una fecha"), now), "none");
  });

  it("hasSignal es lo mismo que «en vivo» o «quieto»", () => {
    assert.equal(hasSignal(at(ago(29_000)), now), true);
    assert.equal(hasSignal(at(ago(31_000)), now), false);
    assert.equal(hasSignal(at(ago(105_000), false), now), true);
    assert.equal(hasSignal(at(null), now), false);
  });

  it("quieto: conserva señal durante el stationary heartbeat (~105 s) hasta STILL_NO_SIGNAL_MS", () => {
    assert.equal(signalState(at(ago(10_000), false), now), "live");
    assert.equal(signalState(at(ago(NO_SIGNAL_MS), false), now), "still");
    assert.equal(signalState(at(ago(105_000), false), now), "still");
    assert.equal(signalState(at(ago(STILL_NO_SIGNAL_MS - 1), false), now), "still");
    assert.equal(signalState(at(ago(STILL_NO_SIGNAL_MS), false), now), "lost");
    assert.equal(hasSignal(at(ago(STILL_NO_SIGNAL_MS), false), now), false);
  });

  it("en movimiento o sin dato de quieto pasa a sin señal a los 30 segundos", () => {
    assert.equal(signalState(at(ago(NO_SIGNAL_MS), true), now), "lost");
    assert.equal(signalState(at(ago(NO_SIGNAL_MS), null), now), "lost");
  });
});

describe("traccarConfigMessage", () => {
  it("pone el identificador, la URL y cada ajuste en su propia línea para copiar fácil", () => {
    const msg = traccarConfigMessage("moto-abc123", "https://bot.staging.dispatch.clapi.solutions/api/gps");
    const lines = msg.split("\n");
    assert.ok(lines.includes("moto-abc123"));
    assert.ok(lines.includes("https://bot.staging.dispatch.clapi.solutions/api/gps"));
    assert.ok(lines.includes("Stationary heartbeat: 60"));
    assert.ok(lines.includes("Stop detection: Desactivado"));
  });
});

describe("positionTime", () => {
  it("con el reloj del celular cerca del servidor, vale la hora del servidor", () => {
    assert.equal(positionTime(ago(20_000), now).getTime(), now.getTime());
    assert.equal(positionTime(new Date(now.getTime() + 20_000), now).getTime(), now.getTime());
  });

  it("un reporte adelantado nunca queda en el futuro", () => {
    assert.equal(positionTime(new Date(now.getTime() + 10 * 60_000), now).getTime(), now.getTime());
  });

  it("un reporte guardado sin conexión conserva su hora y no cuenta como señal", () => {
    const old = ago(5 * 60_000);
    assert.equal(positionTime(old, now).getTime(), old.getTime());
    assert.equal(signalState(at(positionTime(old, now)), now), "lost");
  });
});
