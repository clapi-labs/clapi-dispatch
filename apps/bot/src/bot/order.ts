import {
  EMPTY_TRIP_FIELDS,
  ESCALATION_MESSAGE,
  MAX_CLARIFICATION_ATTEMPTS,
  countFields,
  mergeTripFields,
  missingFields,
  type OrderDraft,
  type OrderFieldKey,
} from "@dispatch/shared";
import {
  assignNextCourier,
  findZoneByName,
  getBotConfig,
  listZones,
  matchZone,
  quoteByDistance,
  quoteFare,
  type Restaurant,
  type Zone,
} from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { notifyAssigned } from "@/bot/notify";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import { createTrip } from "@/db/queries/trips";
import { geocodeAddress } from "@/services/google/geocode";
import { extractTripFields } from "@/services/openai/extract";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * La conversación con el restaurante (docs/BOT.md, «Flujo básico»):
 *
 *   dirección → cotización con botón → confirmación (botón o escrita)
 *             → se piden los datos que falten → viaje creado → despacho
 *
 * El modelo interpreta cada mensaje; el código decide en qué etapa va el
 * pedido y qué se responde. El borrador vive en `conversations.draft` y
 * sobrevive entre mensajes.
 */

export const CONFIRM_BUTTON_ID = "confirmar";

const FIELD_LABEL: Record<OrderFieldKey, string> = {
  origenRestaurante: "dónde se recoge",
  direccionEntrega: "la dirección de entrega",
  telefonoCliente: "el teléfono del cliente",
  nombreCliente: "el nombre del cliente",
  valorACobrar: "el valor a cobrar",
  metodoPago: "si es en efectivo o por transferencia",
  listoEnMinutos: "en cuántos minutos está lista la comida",
  notas: "las indicaciones",
};

const TECHNICAL_ERROR_MESSAGE =
  "Tuve un problema técnico leyendo tu mensaje 🙏 No se perdió nada de lo que ya me diste. ¿Me lo reenvías en un momento?";

function cop(n: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
}

function joinLabels(labels: string[]) {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}`;
}

type Context = {
  conversation: Conversation;
  message: IncomingMessage;
  restaurant: Restaurant | null;
};

async function save(ctx: Context, draft: OrderDraft | null, failedAttempts = 0) {
  await updateConversation(ctx.conversation.id, { draft, failedAttempts });
}

async function escalate(ctx: Context, reason: string) {
  await updateConversation(ctx.conversation.id, { botPaused: true, escalationReason: reason, draft: null, failedAttempts: 0 });
  await say(ctx.conversation.id, ctx.message.phone, ESCALATION_MESSAGE);
}

/** Un mensaje que no aportó nada suma un intento; al tope, pasa a un asesor.
 *  Devuelve `false` si ya escaló. */
async function countAttempt(ctx: Context, draft: OrderDraft, progressed: boolean, reason: string) {
  const attempts = progressed ? 0 : ctx.conversation.failedAttempts + 1;
  if (attempts >= MAX_CLARIFICATION_ATTEMPTS) {
    await escalate(ctx, reason);
    return false;
  }
  await save(ctx, draft, attempts);
  return true;
}

/** La zona sirve para cobrar cuando falta alguna ubicación, y para el portal. */
function resolveZones(draft: OrderDraft, restaurant: Restaurant | null, zones: Zone[]) {
  const pickup = findZoneByName(draft.zonaRecogida, zones) ?? matchZone(restaurant?.knownPickupAddress ?? draft.origenRestaurante ?? "", zones);
  const delivery = findZoneByName(draft.zonaEntrega, zones) ?? matchZone(draft.direccionEntrega ?? "", zones);
  return { pickup, delivery };
}

export async function handleRestaurant(ctx: Context) {
  const { conversation, message, restaurant } = ctx;
  const [config, zones] = await Promise.all([getBotConfig(), listZones()]);

  const known: OrderDraft = { ...EMPTY_TRIP_FIELDS, ...(conversation.draft ?? {}) };
  if (restaurant) known.origenRestaurante = restaurant.name;
  let draft: OrderDraft = { ...known };
  let confirms = false;

  // 1. Lo que trae el mensaje.
  if (message.kind === "button") {
    if (message.buttonId !== CONFIRM_BUTTON_ID) return;
    if (!draft.cotizacion) {
      await say(conversation.id, message.phone, "No tengo un pedido por confirmar 🤔 Envíame la dirección de entrega para cotizarte.");
      return;
    }
    confirms = true;
  } else if (message.kind === "location") {
    // El pin de WhatsApp: coordenadas exactas, sin pagar geocodificación.
    const address = message.label ?? draft.direccionEntrega ?? "Ubicación enviada por WhatsApp";
    draft = { ...draft, direccionEntrega: address, direccionUbicada: address, ubicacionEntrega: { lat: message.lat, lng: message.lng }, cotizacion: null };
  } else if (message.kind === "text") {
    const extraction = await extractTripFields(message.text, draft, zones.map((z) => z.name));
    // OpenAI falló: no es culpa del restaurante, así que no suma intentos, no
    // escala y el borrador queda como estaba. Solo se le pide reenviar.
    if (extraction.failed) {
      await say(conversation.id, message.phone, TECHNICAL_ERROR_MESSAGE);
      return;
    }
    if (extraction.confused) {
      await escalate(ctx, "El restaurante dio datos confusos o pidió hablar con una persona.");
      return;
    }
    draft = mergeTripFields(draft, extraction.fields);
    if (restaurant) draft.origenRestaurante = restaurant.name;
    draft.zonaRecogida = extraction.fields.zonaRecogida ?? draft.zonaRecogida ?? null;
    draft.zonaEntrega = extraction.fields.zonaEntrega ?? draft.zonaEntrega ?? null;
    // El modelo repite el tiempo ya capturado: solo cuando cambia es un dato
    // nuevo, y se cuenta desde este mensaje.
    const timeChanged = draft.listoEnMinutos != null && draft.listoEnMinutos !== known.listoEnMinutos;
    if (timeChanged) draft.listoDesde = message.timestamp.toISOString();
    // Dar el tiempo después de la cotización también es aceptar el servicio
    // (así confirman los restaurantes hoy: «5 mil» → «en 8 minutos»).
    confirms = !!known.cotizacion && (extraction.confirms || timeChanged);
  } else {
    await say(conversation.id, message.phone, "Por ahora leo mensajes de texto y ubicaciones 🙏 ¿Me escribes la dirección de entrega?");
    return;
  }

  const progressed = countFields(draft) > countFields(known) || draft.ubicacionEntrega !== known.ubicacionEntrega;

  // 2. Sin dirección no hay cotización: es lo primero que se pide.
  if (!draft.direccionEntrega) {
    if (!progressed && countFields(known) <= (restaurant ? 1 : 0) && conversation.failedAttempts === 0) {
      const name = restaurant ? `, ${restaurant.name}` : "";
      await save(ctx, draft);
      await say(conversation.id, message.phone, `¡Hola${name}! 🛵 Envíame la dirección de entrega y te cotizo.`);
      return;
    }
    if (await countAttempt(ctx, draft, progressed, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos sin dirección de entrega.`)) {
      await say(conversation.id, message.phone, "Anotado ✅ ¿A qué dirección es la entrega?");
    }
    return;
  }

  // El mensaje que trajo la dirección es el que se cita en los avisos.
  if (!draft.mensajeOrigen) draft.mensajeOrigen = message.waMessageId;

  // 3. Ubicar la dirección, una sola vez por dirección.
  if (draft.direccionEntrega !== draft.direccionUbicada) {
    const geocoded = await geocodeAddress(draft.direccionEntrega);
    if (geocoded.kind === "not_found") {
      draft.direccionUbicada = null;
      if (await countAttempt(ctx, draft, false, `No se pudo ubicar en el mapa la dirección de entrega: ${draft.direccionEntrega}`)) {
        await say(
          conversation.id,
          message.phone,
          `No encuentro «${draft.direccionEntrega}» en el mapa 🗺️ ¿Me la confirmas con el número completo y el barrio? También puedes enviarme la ubicación.`,
          { replyTo: draft.mensajeOrigen },
        );
      }
      return;
    }
    // Si Google falla o no hay llave, se sigue sin coordenadas: se cobra por
    // zona y el despachador lo ve en el portal.
    draft.ubicacionEntrega = geocoded.kind === "found" ? geocoded.location : null;
    draft.direccionUbicada = draft.direccionEntrega;
    draft.cotizacion = null;
  }

  // 4. Cotizar. Un precio nuevo siempre se muestra y se confirma, aunque el
  // restaurante ya hubiera confirmado otra dirección.
  const zonesFound = resolveZones(draft, restaurant, zones);
  if (!draft.cotizacion) {
    const pickupLocation = restaurant?.knownPickupLocation ?? null;
    let km: number | null = null;
    let price: number;
    if (pickupLocation && draft.ubicacionEntrega) {
      const quote = await quoteByDistance(pickupLocation, draft.ubicacionEntrega);
      km = quote.km;
      price = quote.price;
    } else {
      price = await quoteFare(zonesFound.pickup, zonesFound.delivery);
    }

    if (km !== null && config.maxKm !== null && km > config.maxKm) {
      await save(ctx, null);
      await say(conversation.id, message.phone, `Hasta allá no tenemos cobertura 🙏 (${km} km, llegamos hasta ${config.maxKm} km).`, {
        replyTo: draft.mensajeOrigen,
      });
      return;
    }

    draft.cotizacion = { precio: price, km };
    draft.etapa = "cotizado";
    await save(ctx, draft);
    const where = zonesFound.delivery?.name ?? draft.direccionEntrega;
    await say(conversation.id, message.phone, `Serían ${cop(price)} hasta ${where} 🛵`, {
      replyTo: draft.mensajeOrigen,
      buttons: [{ id: CONFIRM_BUTTON_ID, title: "Confirmar servicio" }],
    });
    return;
  }

  // 5. Esperando confirmación.
  if (confirms) draft.etapa = "confirmado";
  if (draft.etapa !== "confirmado") {
    if (await countAttempt(ctx, draft, progressed, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos sin confirmar el servicio.`)) {
      await say(conversation.id, message.phone, `Anotado ✅ Confirma el servicio de ${cop(draft.cotizacion.precio)} y pido la moto.`, {
        replyTo: draft.mensajeOrigen,
        buttons: [{ id: CONFIRM_BUTTON_ID, title: "Confirmar servicio" }],
      });
    }
    return;
  }

  // 6. Confirmado: lo que falte según la agencia.
  const missing = missingFields(draft, config.requiredFields, !!restaurant);
  if (missing.length) {
    if (await countAttempt(ctx, draft, progressed || confirms, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos sin los datos que faltan.`)) {
      await say(conversation.id, message.phone, `Listo ✅ Para pedir la moto me falta ${joinLabels(missing.map((k) => FIELD_LABEL[k]))}.`, {
        replyTo: draft.mensajeOrigen,
      });
    }
    return;
  }

  // 7. Completo: se crea el viaje y se despacha.
  await save(ctx, null);
  const trip = await createTrip(
    conversation.id,
    draft as OrderDraft & { origenRestaurante: string; direccionEntrega: string },
    { price: draft.cotizacion.precio, pickupZone: zonesFound.pickup?.name ?? null, deliveryZone: zonesFound.delivery?.name ?? null },
    restaurant,
  );

  const courierAssigned = await assignNextCourier(trip.id);
  if (courierAssigned) {
    await notifyAssigned(trip.id);
  } else {
    await say(conversation.id, message.phone, `✅ Pedido ${trip.code} confirmado. Las motos están ocupadas: te aviso apenas tenga una asignada.`, {
      replyTo: trip.sourceWaMessageId,
      tripId: trip.id,
    });
  }
}
