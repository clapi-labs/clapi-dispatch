/** Forma del webhook de la Cloud API — solo lo que usamos. Igual que CLAPI. */

export type WaTextMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: "text";
  text: { body: string };
};

/** Respuesta a un botón de respuesta rápida (el «Terminé el servicio» de la ficha). */
export type WaInteractiveMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: "interactive";
  interactive: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
};

/** El pin de ubicación de WhatsApp: coordenadas exactas, sin geocodificar. */
export type WaLocationMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: "location";
  location: { latitude: number; longitude: number; name?: string; address?: string };
};

/** Foto o captura: un pedido que el restaurante copió de otra app, por ejemplo. */
export type WaImageMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: "image";
  image: { id: string; mime_type?: string; caption?: string };
};

export type WaOtherMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: string;
};

/** Cuando el restaurante responde citando un mensaje, llega `context.id`. */
export type WaMessage = (WaTextMessage | WaInteractiveMessage | WaLocationMessage | WaImageMessage | WaOtherMessage) & {
  context?: { id?: string; from?: string };
};

export type WaContact = { wa_id: string; profile?: { name?: string } };

export type WaStatus = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipient_id: string;
};

export type WaWebhookPayload = {
  object: string;
  entry?: {
    id: string;
    changes?: {
      field: string;
      value: {
        messaging_product: string;
        contacts?: WaContact[];
        messages?: WaMessage[];
        statuses?: WaStatus[];
      };
    }[];
  }[];
};

export type IncomingMessage = {
  waMessageId: string;
  phone: string;
  profileName: string | null;
  timestamp: Date;
  /** El wamid del mensaje que citó, si respondió a uno. */
  replyTo?: string | null;
} & (
  /** `images`: fotos que llegaron en el mismo turno (ids de Meta); el texto
   *  es su pie de foto o lo que se escribió junto a ellas. */
  | { kind: "text"; text: string; images?: string[] }
  | { kind: "image"; mediaId: string; caption: string | null }
  | { kind: "location"; lat: number; lng: number; label: string | null }
  | { kind: "button"; buttonId: string; title: string }
  | { kind: "unsupported"; type: string }
);
