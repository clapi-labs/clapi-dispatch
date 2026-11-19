import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { captionOf, mediaOf, mediaUrl, placeholderText, type MediaColumns } from "./media";

const none: MediaColumns = { mediaStatus: null, mediaMime: null, mediaBytes: null, mediaWidth: null, mediaHeight: null, mediaExpiredReason: null };

describe("mediaOf", () => {
  it("un mensaje sin foto no trae media", () => {
    assert.equal(mediaOf(none, 30), null);
  });

  it("una foto en disco: tipo, tamaño y peso", () => {
    const media = mediaOf({ ...none, mediaStatus: "stored", mediaMime: "image/webp", mediaBytes: 61_000, mediaWidth: 1200, mediaHeight: 800 }, 30);
    assert.deepEqual(media, { status: "stored", mime: "image/webp", width: 1200, height: 800, bytes: 61_000 });
  });

  it("una foto en disco sin datos de tamaño sigue siendo válida", () => {
    assert.deepEqual(mediaOf({ ...none, mediaStatus: "stored" }, 30), { status: "stored", mime: "image/webp", width: null, height: null, bytes: 0 });
  });

  it("una foto que la limpieza ya borró: expirada, con el motivo y el plazo vigente", () => {
    assert.deepEqual(mediaOf({ ...none, mediaStatus: "expired", mediaExpiredReason: "ttl" }, 30), { status: "expired", reason: "ttl", retentionDays: 30 });
    assert.deepEqual(mediaOf({ ...none, mediaStatus: "expired", mediaExpiredReason: "space" }, 7), { status: "expired", reason: "space", retentionDays: 7 });
  });

  it("no filtra la ruta del archivo: ni la fila ni el resultado la llevan", () => {
    const media = mediaOf({ ...none, mediaStatus: "stored", mediaMime: "image/webp" }, 30);
    assert.equal(JSON.stringify(media).includes("path"), false);
  });
});

describe("textos", () => {
  it("el pie de foto no lleva la etiqueta [Imagen]", () => {
    assert.equal(captionOf("[Imagen] El pedido de Marta"), "El pedido de Marta");
    assert.equal(captionOf("[Imagen]"), "");
    assert.equal(captionOf("[Imagen]   con espacios  "), "con espacios");
    assert.equal(captionOf("Una [Imagen] a la mitad"), "Una [Imagen] a la mitad");
  });

  it("la foto se pide por el id del mensaje", () => {
    assert.equal(mediaUrl(42), "/api/media/42");
  });

  it("lo que se ve en lugar de una foto que ya no está", () => {
    assert.equal(placeholderText({ status: "expired", reason: "ttl", retentionDays: 30 }), "Imagen expirada (eliminada tras 30 días)");
    assert.equal(placeholderText({ status: "expired", reason: "ttl", retentionDays: 1 }), "Imagen expirada (eliminada tras 1 día)");
    assert.equal(placeholderText({ status: "expired", reason: "space", retentionDays: 30 }), "Imagen eliminada para liberar espacio");
    assert.equal(placeholderText({ status: "expired", reason: null, retentionDays: 30 }), "Imagen expirada");
    assert.equal(placeholderText(null), "Imagen no disponible");
  });
});
