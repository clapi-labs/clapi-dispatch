import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Limiter } from "./limiter";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Una tarea que no termina hasta que se la suelta. */
function gate() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { done, release };
}

describe("Limiter", () => {
  it("deja correr hasta `max` a la vez y el resto espera", async () => {
    const limiter = new Limiter(2);
    const gates = [gate(), gate(), gate(), gate()];
    let concurrent = 0;
    let peak = 0;
    const started: number[] = [];
    const jobs = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await g.done;
        concurrent -= 1;
        return i;
      }),
    );

    await tick();
    assert.deepEqual(started, [0, 1], "solo dos arrancaron");
    assert.deepEqual([limiter.running, limiter.queued], [2, 2]);

    gates[0].release();
    await tick();
    assert.deepEqual(started, [0, 1, 2], "al terminar una, entra la siguiente en orden");

    gates[1].release();
    gates[2].release();
    gates[3].release();
    assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3]);
    assert.equal(peak, 2);
    assert.deepEqual([limiter.running, limiter.queued], [0, 0]);
  });

  it("una tarea que falla no deja ocupado su lugar", async () => {
    const limiter = new Limiter(1);
    await assert.rejects(limiter.run(async () => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(await limiter.run(async () => "sigue"), "sigue");
    assert.equal(limiter.running, 0);
  });

  it("con max 1, las tareas corren de a una y en orden", async () => {
    const limiter = new Limiter(1);
    const order: string[] = [];
    await Promise.all(["a", "b", "c"].map((name) => limiter.run(async () => {
      order.push(`${name}-in`);
      await tick();
      order.push(`${name}-out`);
    })));
    assert.deepEqual(order, ["a-in", "a-out", "b-in", "b-out", "c-in", "c-out"]);
  });

  it("rechaza un máximo que no sirve", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => new Limiter(bad));
  });
});
