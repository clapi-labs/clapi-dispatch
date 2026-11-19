import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseChange, touches } from "./live-event";
import { mergeThread, REFRESH_OVERLAP, refreshAfter } from "./thread";
import type { ChatMessage } from "./types";

const msg = (id: number, text = `m${id}`, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "restaurant",
  text,
  createdAt: new Date(Date.UTC(2026, 10, 19, 12, 0, id)).toISOString(),
  quote: null,
  tripCodes: [],
  ...over,
});

describe("mergeThread: el hilo por páginas", () => {
  it("agrega los nuevos al final, en orden", () => {
    const merged = mergeThread([msg(1), msg(2)], [msg(4), msg(3)]);
    assert.deepEqual(merged.map((m) => m.id), [1, 2, 3, 4]);
  });

  it("«Cargar anteriores» los pone antes", () => {
    const merged = mergeThread([msg(10), msg(11)], [msg(8), msg(9)]);
    assert.deepEqual(merged.map((m) => m.id), [8, 9, 10, 11]);
  });

  it("un mensaje que cambió se reemplaza, sin duplicarse", () => {
    const merged = mergeThread([msg(1), msg(2)], [msg(2, "m2\n\n⚠️ No se pudo entregar por WhatsApp.")]);
    assert.deepEqual(merged.map((m) => [m.id, m.text]), [[1, "m1"], [2, "m2\n\n⚠️ No se pudo entregar por WhatsApp."]]);
  });

  it("también cambian el código del pedido y la cita", () => {
    const base = [msg(1), msg(2)];
    assert.notEqual(mergeThread(base, [msg(2, "m2", { tripCodes: ["A-01"] })]), base);
    assert.notEqual(mergeThread(base, [msg(2, "m2", { quote: { id: 1, role: "bot", text: "x" } })]), base);
  });

  it("si no cambió nada devuelve el mismo arreglo: React no repinta", () => {
    const base = [msg(1), msg(2), msg(3)];
    assert.equal(mergeThread(base, [msg(2), msg(3)]), base);
    assert.equal(mergeThread(base, []), base);
  });
});

describe("refreshAfter: desde dónde ponerse al día", () => {
  it("un hilo vacío pide desde el principio", () => {
    assert.equal(refreshAfter([]), 0);
  });

  it("pide desde unos mensajes antes del último, para ver también los que cambiaron", () => {
    const thread = Array.from({ length: 50 }, (_, i) => msg(100 + i));
    const after = refreshAfter(thread);
    assert.equal(thread.filter((m) => m.id > after).length, REFRESH_OVERLAP);
  });

  it("un hilo corto se vuelve a pedir entero", () => {
    const thread = [msg(7), msg(9)];
    assert.equal(refreshAfter(thread), 6);
  });
});

describe("parseChange: los avisos en vivo", () => {
  it("el nombre de la tabla solo: puede ser cualquier chat", () => {
    assert.deepEqual(parseChange("trips"), { topic: "trips", ids: null });
    assert.deepEqual(parseChange("messages"), { topic: "messages", ids: null });
  });

  it("los mensajes dicen de qué chats son", () => {
    assert.deepEqual(parseChange("messages:12,15"), { topic: "messages", ids: [12, 15] });
  });

  it("ids raros se ignoran; sin ninguno válido vale para todos", () => {
    assert.deepEqual(parseChange("messages:x,,-3"), { topic: "messages", ids: null });
    assert.deepEqual(parseChange("messages:4,abc"), { topic: "messages", ids: [4] });
  });

  it("el hilo abierto solo se pone al día con su chat (o con uno sin decir cuál)", () => {
    assert.equal(touches(parseChange("messages:12,15"), 12), true);
    assert.equal(touches(parseChange("messages:12,15"), 7), false);
    assert.equal(touches(parseChange("messages"), 7), true);
  });
});
