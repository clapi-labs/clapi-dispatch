import type { schema } from "@dispatch/shared/db";

import type { IncomingMessage, TurnButton, TurnPin } from "@/services/whatsapp/types";

type Row = Pick<typeof schema.messages.$inferSelect, "id" | "waMessageId" | "createdAt" | "text" | "incoming">;

type Sender = Pick<IncomingMessage, "phone" | "profileName">;

/**
 * Lo que el restaurante mandó seguido, mientras el bot esperaba, es un solo
 * turno y se responde con un solo mensaje: «Calle 48 # 98-20» + «apto 402» +
 * «en 10», o un pin + «me das un domi para esta dirección». Textos y fotos se
 * juntan en un texto; ubicaciones y botones van con él. Un pin que llega
 * después de algún texto queda marcado en el texto donde llegó (`pinLine`).
 *
 * La única excepción es el botón para elegir de qué pedido habla
 * (`separateButton`): responde a otra pregunta, así que parte el turno.
 *
 * El turno conserva el wamid y la hora del primer mensaje, que es el que se
 * cita en los avisos y desde el que se cuenta el tiempo de preparación.
 * Un turno de un solo mensaje queda tal cual llegó.
 */
export function mergeTurns(rows: Row[], from: Sender, separateButton: (buttonId: string) => boolean): IncomingMessage[] {
  const turns: IncomingMessage[] = [];
  let group: Row[] = [];
  const flush = () => {
    if (group.length) turns.push(group.length === 1 ? single(group[0], from) : combined(group, from));
    group = [];
  };
  for (const row of rows) {
    const payload = payloadOf(row);
    if (payload.kind === "button" && separateButton(payload.buttonId)) {
      flush();
      turns.push(single(row, from));
      continue;
    }
    group.push(row);
  }
  flush();
  return turns;
}

/** La dirección con que se guarda la entrega de un pin. */
export function pinAddress(pin: Pick<TurnPin, "label">) {
  return pin.label ?? "Ubicación enviada por WhatsApp";
}

/** Cómo lee el modelo un pin que llegó en medio del texto. */
export function pinLine(pin: Pick<TurnPin, "label">) {
  return `(Ubicación de WhatsApp: ${pinAddress(pin)})`;
}

function payloadOf(row: Row): schema.IncomingPayload {
  return row.incoming ?? { kind: "text", text: row.text };
}

function base(row: Row, from: Sender) {
  return {
    phone: from.phone,
    profileName: from.profileName,
    waMessageId: row.waMessageId ?? `msg-${row.id}`,
    timestamp: row.createdAt,
    replyTo: payloadOf(row).replyTo ?? null,
  };
}

function single(row: Row, from: Sender): IncomingMessage {
  const payload = payloadOf(row);
  const head = base(row, from);
  switch (payload.kind) {
    case "text":
      return { ...head, kind: "text", text: payload.text };
    case "image":
      return { ...head, kind: "text", text: payload.caption ?? "", images: [payload.mediaId] };
    case "location":
      return { ...head, kind: "location", lat: payload.lat, lng: payload.lng, label: payload.label };
    case "button":
      return { ...head, kind: "button", buttonId: payload.buttonId, title: payload.title };
    default:
      return { ...head, kind: "unsupported", type: payload.type };
  }
}

function combined(rows: Row[], from: Sender): IncomingMessage {
  const texts: string[] = [];
  const images: string[] = [];
  const pins: TurnPin[] = [];
  const buttons: TurnButton[] = [];
  let unsupported = false;
  let replyTo: string | null = null;
  for (const row of rows) {
    const payload = payloadOf(row);
    replyTo ??= payload.replyTo ?? null;
    switch (payload.kind) {
      case "text":
        if (payload.text.trim()) texts.push(payload.text);
        break;
      case "image":
        images.push(payload.mediaId);
        if (payload.caption?.trim()) texts.push(payload.caption);
        break;
      case "location": {
        const pin = { lat: payload.lat, lng: payload.lng, label: payload.label, beforeText: texts.length === 0 && images.length === 0 };
        pins.push(pin);
        // Después de un texto, el pin queda marcado donde llegó: «¿me cotizas
        // a esta?» + pin + «y otro a la Cra 98» habla de dos entregas.
        if (!pin.beforeText) texts.push(pinLine(pin));
        break;
      }
      case "button":
        buttons.push({ buttonId: payload.buttonId, title: payload.title });
        break;
      default:
        unsupported = true;
    }
  }
  return {
    ...base(rows[0], from),
    replyTo,
    kind: "text",
    text: texts.join("\n"),
    ...(images.length ? { images } : {}),
    ...(pins.length ? { pins } : {}),
    ...(buttons.length ? { buttons } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}
