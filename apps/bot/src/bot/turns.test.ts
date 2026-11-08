import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { schema } from "@dispatch/shared/db";

import { mergeTurns } from "./turns";

type Payload = schema.IncomingPayload;

let id = 0;
const row = (incoming: Payload) => {
  id++;
  const text = incoming.kind === "text" ? incoming.text : `[${incoming.kind}]`;
  return { id, waMessageId: `wamid-${id}`, createdAt: new Date(1_700_000_000_000 + id * 1000), text, incoming };
};

const FROM = { phone: "573000000001", profileName: null };
const isPick = (buttonId: string) => buttonId.startsWith("pedido:");

const text = (t: string, replyTo: string | null = null): Payload => ({ kind: "text", text: t, replyTo });
const pin: Payload = { kind: "location", lat: 3.46, lng: -76.53, label: "Conjunto Residencial Canelo", replyTo: null };
const confirm: Payload = { kind: "button", buttonId: "confirmar", title: "Confirmar servicio", replyTo: null };
const audio: Payload = { kind: "unsupported", type: "audio", replyTo: null };

describe("mergeTurns", () => {
  it("un pin y un texto seguidos son un solo turno", () => {
    const rows = [row(pin), row(text("Buenas me das un domi para esta direccion"))];
    const turns = mergeTurns(rows, FROM, isPick);
    assert.equal(turns.length, 1);
    const [turn] = turns;
    assert.equal(turn.kind, "text");
    if (turn.kind !== "text") return;
    assert.equal(turn.text, "Buenas me das un domi para esta direccion");
    assert.deepEqual(turn.pins, [{ lat: 3.46, lng: -76.53, label: "Conjunto Residencial Canelo", beforeText: true }]);
    assert.equal(turn.waMessageId, rows[0].waMessageId, "se cita el primer mensaje");
    assert.equal(turn.timestamp, rows[0].createdAt);
  });

  it("cuatro mensajes de todo tipo son un solo turno, en su orden", () => {
    const rows = [row(text("Domi a la Cra 98 # 45-30")), row(pin), row(confirm), row(text("cliente Ana 3001234567")), row(audio)];
    const turns = mergeTurns(rows, FROM, isPick);
    assert.equal(turns.length, 1);
    const [turn] = turns;
    if (turn.kind !== "text") return assert.fail("debía ser un texto");
    assert.equal(turn.text, "Domi a la Cra 98 # 45-30\n(Ubicación de WhatsApp: Conjunto Residencial Canelo)\ncliente Ana 3001234567", "el pin queda marcado donde llegó");
    assert.equal(turn.pins?.[0].beforeText, false, "el pin llegó después del texto");
    assert.deepEqual(turn.buttons, [{ buttonId: "confirmar", title: "Confirmar servicio" }]);
    assert.equal(turn.unsupported, true);
  });

  it("textos y fotos se juntan como antes", () => {
    const photo: Payload = { kind: "image", mediaId: "media-1", caption: "este pedido", replyTo: null };
    const [turn] = mergeTurns([row(text("Hola")), row(photo), row(text("en 10"))], FROM, isPick);
    if (turn.kind !== "text") return assert.fail("debía ser un texto");
    assert.equal(turn.text, "Hola\neste pedido\nen 10");
    assert.deepEqual(turn.images, ["media-1"]);
    assert.equal(turn.pins, undefined);
  });

  it("se cita el primer mensaje que citó algo", () => {
    const [turn] = mergeTurns([row(text("ya está")), row(text("el de la 42", "wamid-pedido"))], FROM, isPick);
    assert.equal(turn.replyTo, "wamid-pedido");
  });

  it("un mensaje suelto queda tal cual llegó", () => {
    const [location] = mergeTurns([row(pin)], FROM, isPick);
    assert.equal(location.kind, "location");
    const [button] = mergeTurns([row(confirm)], FROM, isPick);
    assert.equal(button.kind, "button");
    const [other] = mergeTurns([row(audio)], FROM, isPick);
    assert.equal(other.kind, "unsupported");
    const [photo] = mergeTurns([row({ kind: "image", mediaId: "m", caption: null, replyTo: null })], FROM, isPick);
    assert.deepEqual(photo.kind === "text" && { text: photo.text, images: photo.images }, { text: "", images: ["m"] });
  });

  it("el botón para elegir el pedido parte el turno", () => {
    const pick: Payload = { kind: "button", buttonId: "pedido:12", title: "A-12", replyTo: null };
    const turns = mergeTurns([row(text("ya está listo")), row(pick), row(text("y otro a la Cra 5"))], FROM, isPick);
    assert.deepEqual(
      turns.map((t) => t.kind),
      ["text", "button", "text"],
    );
  });
});
