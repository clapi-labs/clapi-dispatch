import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSendQueue, type SendResult } from "./send-queue";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createSendQueue", () => {
  it("manda en orden aunque el primero tarde más", async () => {
    const sent: string[] = [];
    const enqueue = createSendQueue(async (text) => {
      await wait(text === "uno" ? 30 : 1);
      sent.push(text);
      return { ok: true };
    });
    const done = () => {};
    enqueue("uno", { onFail: () => {}, onDone: done });
    await enqueue("dos", { onFail: () => {}, onDone: done });
    assert.deepEqual(sent, ["uno", "dos"]);
  });

  it("no bloquea a quien encola: devuelve sin esperar al servidor", async () => {
    let resolve!: (r: SendResult) => void;
    const enqueue = createSendQueue(() => new Promise<SendResult>((r) => (resolve = r)));
    let finished = false;
    const pending = enqueue("hola", { onFail: () => {}, onDone: () => (finished = true) });
    await wait(5);
    assert.equal(finished, false);
    resolve({ ok: true });
    await pending;
    assert.equal(finished, true);
  });

  it("avisa con el texto y el motivo cuando el servidor responde con error", async () => {
    const failed: [string, string | undefined][] = [];
    const enqueue = createSendQueue(async () => ({ ok: false, reason: "ventana" }));
    await enqueue("hola", { onFail: (t, r) => failed.push([t, r]), onDone: () => {} });
    assert.deepEqual(failed, [["hola", "ventana"]]);
  });

  it("trata una caída de red como fallo y sigue con el siguiente", async () => {
    const failed: string[] = [];
    const sent: string[] = [];
    const enqueue = createSendQueue(async (text) => {
      if (text === "malo") throw new Error("red");
      sent.push(text);
      return { ok: true };
    });
    enqueue("malo", { onFail: (t) => failed.push(t), onDone: () => {} });
    await enqueue("bueno", { onFail: (t) => failed.push(t), onDone: () => {} });
    assert.deepEqual(failed, ["malo"]);
    assert.deepEqual(sent, ["bueno"]);
  });

  it("llama a onDone siempre, salga o falle", async () => {
    let done = 0;
    const enqueue = createSendQueue(async (t) => (t === "x" ? { ok: false } : { ok: true }));
    enqueue("x", { onFail: () => {}, onDone: () => done++ });
    await enqueue("y", { onFail: () => {}, onDone: () => done++ });
    assert.equal(done, 2);
  });
});
