import { ESCALATION_MESSAGE, normalizeDraft } from "@dispatch/shared";
import {
  claimRestaurantPhone,
  findRestaurantByPhone,
  restaurantsNamed,
  restaurantsNamedIn,
  type Restaurant,
} from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * Quién escribe (docs/BOT.md, «Reconocer al restaurante»). Se usan el número y
 * el nombre: con los dos se verifica, con uno alcanza, y si no hay ninguno claro
 * entra al flujo de restaurante nuevo. El número de una moto gana siempre: eso
 * se resuelve antes, en intake.ts.
 *
 * El nombre es el que dice en el mensaje o el de su perfil de WhatsApp. El perfil
 * suele ser personal: si no coincide, no es un conflicto, solo no hay nombre.
 */

export const IDENTITY_YES = "identidad:si";
export const IDENTITY_NO = "identidad:no";

export type Identity =
  | { kind: "known"; restaurant: Restaurant }
  | { kind: "new" }
  /** Número registrado que dice ser otro restaurante. */
  | { kind: "ask"; restaurant: Restaurant; claimed: Restaurant }
  /** Número nuevo con el nombre de un restaurante que tiene otro número. */
  | { kind: "central"; claimed: Restaurant };

export async function identifyRestaurant(phone: string, text: string | null, profileName: string | null): Promise<Identity> {
  const byPhone = await findRestaurantByPhone(phone);
  const named = text ? await restaurantsNamedIn(text) : [];

  if (byPhone) {
    const others = named.filter((r) => r.id !== byPhone.id);
    if (others.length && !named.some((r) => r.id === byPhone.id)) return { kind: "ask", restaurant: byPhone, claimed: others[0] };
    return { kind: "known", restaurant: byPhone };
  }

  // Parecido a varios, o ninguno: restaurante nuevo, como hoy.
  const candidates = named.length ? named : profileName ? await restaurantsNamed(profileName) : [];
  if (candidates.length !== 1) return { kind: "new" };
  const [match] = candidates;
  if (match.phone) return { kind: "central", claimed: match };
  // Un restaurante sin número: se le guarda este.
  const claimed = await claimRestaurantPhone(match.id, phone);
  return claimed ? { kind: "known", restaurant: claimed } : { kind: "central", claimed: match };
}

const YES = /^(s[ií]|sip|claro|correcto|as[ií] es|exacto|ese mismo|s[ií] señor|s[ií] señora)\b/iu;
const NO = /^(no|nop|negativo)\b/iu;

function answerOf(message: IncomingMessage): boolean | null {
  if (message.kind === "button") return message.buttonId === IDENTITY_YES ? true : message.buttonId === IDENTITY_NO ? false : null;
  if (message.kind !== "text") return null;
  const text = message.text.trim();
  return YES.test(text) ? true : NO.test(text) ? false : null;
}

async function toCentral(conversation: Conversation, phone: string, reason: string) {
  await updateConversation(conversation.id, { botPaused: true, escalationReason: reason, draft: null, failedAttempts: 0 });
  await say(conversation.id, phone, ESCALATION_MESSAGE);
}

/**
 * Con qué restaurante sigue la conversación. `null` si ya se respondió aquí (se
 * le preguntó quién es o pasó a la central). Si responde que sí a la pregunta,
 * sigue con el mensaje que había quedado esperando.
 */
export async function resolveRestaurant(
  conversation: Conversation,
  message: IncomingMessage,
): Promise<{ conversation: Conversation; message: IncomingMessage; restaurant: Restaurant | null } | null> {
  const draft = normalizeDraft(conversation.draft);
  const pending = draft.confirmarIdentidad;

  if (pending) {
    const answer = answerOf(message);
    const cleared = { ...draft, confirmarIdentidad: null, identidadConfirmada: answer === true || draft.identidadConfirmada };
    if (answer === false) {
      await toCentral(conversation, message.phone, `El número de ${pending.registrado} dijo ser ${pending.dice} y respondió que no es ${pending.registrado}.`);
      return null;
    }
    await updateConversation(conversation.id, { draft: cleared });
    const fresh = { ...conversation, draft: cleared };
    if (answer === true) {
      const restaurant = await findRestaurantByPhone(message.phone);
      const waiting: IncomingMessage = {
        ...message,
        kind: "text",
        text: pending.texto,
        waMessageId: pending.mensaje,
        replyTo: null,
        ...(pending.imagenes?.length ? { images: pending.imagenes } : {}),
      };
      return { conversation: fresh, message: waiting, restaurant };
    }
    // Respondió otra cosa: la pregunta se deja y este mensaje sigue como cualquiera.
    conversation = fresh;
  }

  if (message.kind !== "text") return { conversation, message, restaurant: await findRestaurantByPhone(message.phone) };

  const identity = await identifyRestaurant(message.phone, message.text, conversation.displayName);
  if (identity.kind === "known") return { conversation, message, restaurant: identity.restaurant };
  if (identity.kind === "new") return { conversation, message, restaurant: null };
  if (identity.kind === "central") {
    await toCentral(conversation, message.phone, `Un número nuevo dice ser ${identity.claimed.name}, que tiene otro número registrado. No se cambió nada.`);
    return null;
  }

  // Número registrado que dice ser otro: no se crea ni se renombra nada. Se
  // pregunta una vez; si ya dijo que sí en este pedido, se sigue.
  const current = normalizeDraft(conversation.draft);
  if (current.identidadConfirmada) return { conversation, message, restaurant: identity.restaurant };
  const asked = {
    ...current,
    confirmarIdentidad: {
      registrado: identity.restaurant.name,
      dice: identity.claimed.name,
      texto: message.text,
      mensaje: message.waMessageId,
      imagenes: message.images ?? [],
    },
  };
  await updateConversation(conversation.id, { draft: asked });
  await say(conversation.id, message.phone, `¿Hablo con ${identity.restaurant.name}?`, {
    replyTo: message.waMessageId,
    buttons: [
      { id: IDENTITY_YES, title: "Sí" },
      { id: IDENTITY_NO, title: "No" },
    ],
  });
  return null;
}
