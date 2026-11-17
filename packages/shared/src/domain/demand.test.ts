import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_DEMAND_CONFIG,
  INITIAL_DEMAND_STATE,
  demandSignal,
  demandSummary,
  modeForDemand,
  normalizeDemandConfig,
  pendingDemandChange,
  stepDemand,
  validateDemandConfig,
  type DemandMetrics,
  type DemandState,
} from "./demand";

/**
 * La demanda (docs/ALGORITMO.md, «Demanda»): sube cuando hay muchos pedidos
 * esperando o entrando para las motos que hay, baja cuando se calma, y en los
 * dos casos solo si la situación se mantiene.
 */

const c = DEFAULT_DEMAND_CONFIG;
const T0 = new Date("2026-11-17T15:00:00-05:00"); // 3 p.m.: la hora no cuenta

const metrics = (m: Partial<DemandMetrics>): DemandMetrics => ({
  waiting: 0,
  scheduled: 0,
  arrivals: 0,
  windowMin: c.windowMin,
  connected: 3,
  live: 3,
  counted: 3,
  free: 2,
  ...m,
});

const busy = metrics({ waiting: 5, free: 1, arrivals: 3 });
const calm = metrics({ waiting: 0, free: 2, arrivals: 1 });
const middle = metrics({ waiting: 2, free: 1, arrivals: 2 });

/** Corre un tick cada 5 s durante `seconds`, con la misma medición. */
function run(state: DemandState, m: DemandMetrics, from: Date, seconds: number) {
  let s = state;
  const changes: Date[] = [];
  for (let t = 0; t <= seconds; t += 5) {
    const now = new Date(from.getTime() + t * 1000);
    const r = stepDemand(s, m, c, now);
    if (r.changed) changes.push(now);
    s = r.state;
  }
  return { state: s, changes };
}

const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

describe("la señal de un momento", () => {
  it("muchos pedidos esperando y una moto libre: alta", () => {
    assert.equal(demandSignal(busy, c), "alta");
  });

  it("un pedido suelto con una sola moto libre no es alta", () => {
    assert.equal(demandSignal(metrics({ waiting: 1, free: 1, arrivals: 1, counted: 1, connected: 1, live: 1 }), c), "baja");
  });

  it("muchos pedidos entrando para pocas motos: alta, aunque todavía no esperen", () => {
    assert.equal(demandSignal(metrics({ waiting: 0, free: 1, arrivals: 4, counted: 2 }), c), "alta");
  });

  it("el ritmo solo cuenta con pocas motos libres: con muchas libres, la racha ya se atiende", () => {
    // Lo que pasó en la prueba con docker compose: la racha seguía en la ventana con 6 de 8 libres.
    assert.equal(demandSignal(metrics({ waiting: 0, free: 6, arrivals: 8, counted: 8, connected: 8, live: 8 }), c), "baja");
    assert.equal(demandSignal(metrics({ waiting: 0, free: 3, arrivals: 14, counted: 3 }), c), "baja");
    // Con la mitad o menos libres, el mismo ritmo sí pide subir.
    assert.equal(demandSignal(metrics({ waiting: 0, free: 4, arrivals: 8, counted: 8, connected: 8, live: 8 }), c), "alta");
    // Sin motos no hay quién esté libre: el ritmo cuenta.
    assert.equal(demandSignal(metrics({ waiting: 0, free: 0, arrivals: 4, counted: 0, connected: 0, live: 0 }), c), "alta");
  });

  it("los que esperan se miden contra las motos libres", () => {
    // 4 esperando con 2 libres es justo el umbral (2 por moto libre).
    assert.equal(demandSignal(metrics({ waiting: 4, free: 2, arrivals: 0 }), c), "alta");
    assert.equal(demandSignal(metrics({ waiting: 4, free: 3, arrivals: 0 }), c), "media");
  });

  it("sin motos conectadas, tres pedidos esperando ya es alta", () => {
    assert.equal(demandSignal(metrics({ waiting: 3, free: 0, counted: 0, connected: 0, live: 0 }), c), "alta");
  });

  it("entre los dos umbrales no pide nada", () => {
    assert.equal(demandSignal(middle, c), "media");
  });
});

describe("sube", () => {
  it("después de riseMin seguidos en alta, no antes", () => {
    const { state, changes } = run(INITIAL_DEMAND_STATE(T0), busy, T0, 5 * 60);
    assert.equal(state.level, "alta");
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.getTime() - T0.getTime(), c.riseMin * 60_000);
  });

  it("un minuto de alta no alcanza", () => {
    const { state } = run(INITIAL_DEMAND_STATE(T0), busy, T0, 60);
    assert.equal(state.level, "baja");
    assert.deepEqual(pendingDemandChange(state, c, at(T0, 60)), { to: "alta", minutesLeft: c.riseMin - 1 });
  });

  it("si se corta, la cuenta vuelve a empezar", () => {
    let s = run(INITIAL_DEMAND_STATE(T0), busy, T0, 150).state; // 2,5 min
    s = stepDemand(s, middle, c, at(T0, 155)).state; // un momento sin alta
    assert.equal(s.candidateSince, null);
    s = run(s, busy, at(T0, 160), 150).state; // otros 2,5 min
    assert.equal(s.level, "baja");
  });

  it("con riseMin en 0 sube en el acto", () => {
    const r = stepDemand(INITIAL_DEMAND_STATE(T0), busy, { ...c, riseMin: 0 }, T0);
    assert.equal(r.changed, true);
    assert.equal(r.state.level, "alta");
  });
});

describe("baja", () => {
  const high: DemandState = { level: "alta", since: T0, candidateSince: null, measuredAt: T0 };

  it("después de fallMin seguidos en calma, no antes", () => {
    const early = run(high, calm, T0, (c.fallMin - 1) * 60);
    assert.equal(early.state.level, "alta");
    const { state, changes } = run(high, calm, T0, (c.fallMin + 1) * 60);
    assert.equal(state.level, "baja");
    assert.equal(changes[0]!.getTime() - T0.getTime(), c.fallMin * 60_000);
  });

  it("un minuto tranquilo no la baja", () => {
    let s = run(high, calm, T0, 60).state;
    s = run(s, busy, at(T0, 65), 30).state;
    s = run(s, calm, at(T0, 100), (c.fallMin - 2) * 60).state;
    assert.equal(s.level, "alta");
  });

  it("en la zona del medio se queda donde está", () => {
    assert.equal(run(high, middle, T0, 30 * 60).state.level, "alta");
    assert.equal(run(INITIAL_DEMAND_STATE(T0), middle, T0, 30 * 60).state.level, "baja");
  });
});

describe("no cambia a cada rato", () => {
  it("una situación que sube y baja cada minuto no mueve el nivel", () => {
    let s = INITIAL_DEMAND_STATE(T0);
    let changes = 0;
    for (let minute = 0; minute < 60; minute++) {
      const r = run(s, minute % 2 ? busy : calm, at(T0, minute * 60), 55);
      s = r.state;
      changes += r.changes.length;
    }
    assert.equal(changes, 0);
    assert.equal(s.level, "baja");
  });

  it("si el tick deja de medir un rato, lo acumulado no cuenta", () => {
    let s = run(INITIAL_DEMAND_STATE(T0), busy, T0, 120).state;
    // 10 minutos sin medir: al volver empieza de cero.
    const r = stepDemand(s, busy, c, at(T0, 120 + 600));
    s = r.state;
    assert.equal(r.changed, false);
    assert.equal(s.candidateSince?.getTime(), at(T0, 720).getTime());
  });
});

describe("lo que ven los demás", () => {
  it("alta es pico y baja es valle", () => {
    assert.equal(modeForDemand("alta"), "pico");
    assert.equal(modeForDemand("baja"), "valle");
  });

  it("el porqué con sus números", () => {
    assert.equal(
      demandSummary(metrics({ waiting: 5, free: 1, arrivals: 7, counted: 3 })),
      "5 pedidos esperando, 1 moto libre · 7 entraron en 15 min con 3 motos",
    );
    assert.equal(demandSummary(metrics({ waiting: 1, free: 0, arrivals: 1, counted: 1 })), "1 pedido esperando, 0 motos libres · 1 entró en 15 min con 1 moto");
  });

  it("los umbrales del portal se revisan", () => {
    assert.deepEqual(validateDemandConfig({ ...c, waitingPerFree: "2,5" }), { config: { ...c, waitingPerFree: 2.5 } });
    assert.ok("error" in validateDemandConfig({ ...c, riseMin: 1.5 }));
    assert.ok("error" in validateDemandConfig({ ...c, minWaiting: 0 }));
    assert.ok("error" in validateDemandConfig({ ...c, fallMin: undefined }));
  });

  it("lo guardado que no sirve toma el valor por defecto, campo por campo", () => {
    assert.deepEqual(normalizeDemandConfig({ minWaiting: 5, riseMin: -1 }), { ...c, minWaiting: 5 });
    assert.deepEqual(normalizeDemandConfig(null), c);
  });
});
