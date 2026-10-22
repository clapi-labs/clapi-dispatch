import { and, desc, eq, sql } from "drizzle-orm";

import {
  EMPTY_TRIP_FIELDS,
  ESCALATION_MESSAGE,
  MAX_CLARIFICATION_ATTEMPTS,
  evaluateExtraction,
  mergeTripFields,
} from "@dispatch/shared";
import { assignNextCourier, completeTrip, db, findZoneByName, listZones, matchZone, quoteFare, schema } from "@dispatch/shared/db";

import { recordMessage, updateConversation, upsertConversationOnInbound, type Conversation } from "@/db/queries/conversation";
import { createTrip } from "@/db/queries/trips";
import { DELIVER_BUTTON_PREFIX, notifyAssigned, notifyDelivered, sendCourierTicket } from "@/bot/notify";
import { extractTripFields } from "@/services/openai/extract";
import { sendText } from "@/services/whatsapp/client";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * Por el mismo número escriben dos tipos de personas:
 *
 * - **Motorizados** (su teléfono está en la flota): confirman entregas con el
 *   botón de la ficha, o escriben para "conectarse".
 * - **Restaurantes** (cualquier otro número): piden motos en texto libre.
 *
 * El flujo del restaurante tiene tres salidas: pedido completo (se crea el
 * viaje y se asigna la moto), incompleto (se guarda lo entendido y se
 * pregunta lo que falta) o confuso / atascado (se pasa a un asesor).
 */

const FIELD_LABEL: Record<string, string> = {
  origenRestaurante: "dónde se recoge",
  direccionEntrega: "la dirección de entrega",
  telefonoCliente: "el teléfono del cliente",
  valorACobrar: "el valor a cobrar",
  metodoPago: "si es en efectivo o por transferencia",
};

const TEMPLATE =
  "¡Hola! 🛵 Para pedir una moto envíame:\n\n• Dónde se recoge (dirección y barrio)\n• Dirección de entrega (con barrio)\n• Teléfono del cliente\n• Valor a cobrar\n• Efectivo o transferencia\n\nPuede ser en un solo mensaje o por partes.";

const TECHNICAL_ERROR_MESSAGE =
  "Tuve un problema técnico leyendo tu mensaje 🙏 No se perdió nada de lo que ya me diste. ¿Me lo reenvías en un momento?";

function joinLabels(labels: string[]) {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}`;
}

async function reply(conversation: Conversation, phone: string, text: string) {
  await recordMessage(conversation.id, "bot", text);
  await sendText(phone, text);
}

/** Los últimos 10 dígitos: un motorizado guardado como "3001234567" y el
 *  wa_id "573001234567" de WhatsApp son la misma persona. */
async function findCourier(phone: string) {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  const [courier] = await db
    .select()
    .from(schema.couriers)
    .where(and(eq(schema.couriers.active, true), sql`right(regexp_replace(${schema.couriers.phone}, '\\D', '', 'g'), 10) = ${last10}`))
    .limit(1);
  return courier ?? null;
}

async function handleCourier(courier: typeof schema.couriers.$inferSelect, conversation: Conversation, message: IncomingMessage) {
  if (message.kind === "button" && message.buttonId.startsWith(DELIVER_BUTTON_PREFIX)) {
    const tripId = Number(message.buttonId.slice(DELIVER_BUTTON_PREFIX.length));
    const result = await completeTrip(tripId);
    if (!result) {
      await reply(conversation, message.phone, "Ese viaje ya estaba cerrado ✅");
      return;
    }
    await notifyDelivered(tripId);
    // La moto que se liberó puede haber tomado un pendiente en el acto.
    for (const id of result.newlyAssigned) await notifyAssigned(id);
    return;
  }

  // Cualquier otro mensaje: si tiene un viaje en curso, se le reenvía la
  // ficha (con el botón); si no, queda conectado y libre.
  const [active] = await db
    .select({ trip: schema.trips })
    .from(schema.assignments)
    .innerJoin(schema.trips, eq(schema.trips.id, schema.assignments.tripId))
    .where(and(eq(schema.assignments.courierId, courier.id), eq(schema.trips.status, "en_route")))
    .orderBy(desc(schema.assignments.assignedAt))
    .limit(1);

  if (active) {
    await sendCourierTicket(message.phone, active.trip);
    return;
  }

  if (courier.status === "offline" || courier.status === "paused") {
    await db.update(schema.couriers).set({ status: "available" }).where(eq(schema.couriers.id, courier.id));
  }
  await reply(conversation, message.phone, `👋 ${courier.name.split(" ")[0]}, estás conectado a la central. Te escribo apenas tengas un viaje 🛵`);
}

async function escalate(conversation: Conversation, phone: string, reason: string) {
  await updateConversation(conversation.id, { botPaused: true, escalationReason: reason, draft: null, failedAttempts: 0 });
  await reply(conversation, phone, ESCALATION_MESSAGE);
}

export async function handleIncoming(message: IncomingMessage) {
  const conversation = await upsertConversationOnInbound(message.phone, message.profileName);
  const text = message.kind === "text" ? message.text : message.kind === "button" ? `[Botón] ${message.title}` : `[${message.type}]`;

  await recordMessage(conversation.id, "restaurant", text, { waMessageId: message.waMessageId });

  // El motorizado va primero: su "Confirmar entrega" tiene que funcionar
  // siempre, aunque alguien haya pausado el bot en su chat.
  const courier = await findCourier(message.phone);
  if (courier) return handleCourier(courier, conversation, message);

  // Con un asesor al frente, el bot no contesta nada: escuchar y callar.
  if (conversation.botPaused) return;

  if (message.kind !== "text") {
    await reply(conversation, message.phone, "Por ahora solo leo mensajes de texto. " + TEMPLATE);
    return;
  }

  const zones = await listZones();
  const known = conversation.draft ?? EMPTY_TRIP_FIELDS;
  const extraction = await extractTripFields(
    message.text,
    known,
    zones.map((z) => z.name),
  );

  // OpenAI falló: no es culpa del restaurante, así que no suma intentos, no
  // escala y el borrador queda como estaba. Solo se le pide reenviar.
  if (extraction.failed) {
    await reply(conversation, message.phone, TECHNICAL_ERROR_MESSAGE);
    return;
  }

  const merged = mergeTripFields(known, extraction.fields);

  if (extraction.confused) {
    await escalate(conversation, message.phone, "El restaurante dio datos confusos o pidió hablar con una persona.");
    return;
  }

  const result = evaluateExtraction(merged);

  if (result.complete) {
    // La zona la propone el modelo; si no la reconoce, se buscan las
    // palabras clave de cada zona en la dirección. Sin zona: tarifa base.
    const pickupZone = findZoneByName(merged.zonaRecogida, zones) ?? matchZone(result.fields.origenRestaurante, zones);
    const deliveryZone = findZoneByName(merged.zonaEntrega, zones) ?? matchZone(result.fields.direccionEntrega, zones);
    const price = await quoteFare(pickupZone, deliveryZone);

    await updateConversation(conversation.id, { draft: null, failedAttempts: 0 });
    const trip = await createTrip(conversation.id, result.fields, {
      price,
      pickupZone: pickupZone?.name ?? null,
      deliveryZone: deliveryZone?.name ?? null,
    });

    const courierAssigned = await assignNextCourier(trip.id);
    if (courierAssigned) {
      await notifyAssigned(trip.id);
    } else {
      await reply(
        conversation,
        message.phone,
        `✅ Pedido ${trip.code} recibido. Todas las motos están en ruta: te asignamos la primera que se libere y te aviso por acá.`,
      );
    }
    return;
  }

  // Un saludo o un mensaje sin ningún dato no cuenta como intento fallido.
  const nothingYet = result.missing.length === 5 && !merged.zonaRecogida && !merged.zonaEntrega;
  if (nothingYet && conversation.failedAttempts === 0) {
    await reply(conversation, message.phone, TEMPLATE);
    return;
  }

  // Intento fallido = un mensaje que no aportó NINGÚN dato nuevo. El
  // restaurante que manda los datos por partes está colaborando.
  const filled = (f: typeof merged) => Object.values(f).filter((v) => v !== null).length;
  const progressed = filled(merged) > filled(known);
  const attempts = progressed ? conversation.failedAttempts : conversation.failedAttempts + 1;

  if (attempts >= MAX_CLARIFICATION_ATTEMPTS) {
    await escalate(conversation, message.phone, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos sin datos nuevos del pedido.`);
    return;
  }

  await updateConversation(conversation.id, { draft: merged, failedAttempts: attempts });
  const missing = joinLabels(result.missing.map((key) => FIELD_LABEL[key]));
  await reply(conversation, message.phone, `Perfecto, ya lo tengo anotado. Solo me falta ${missing}. ¿Me lo confirmas?`);
}
