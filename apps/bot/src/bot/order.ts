import {
  ESCALATION_MESSAGE,
  MAX_CLARIFICATION_ATTEMPTS,
  countFields,
  emptyDelivery,
  mergeTripFields,
  missingFields,
  normalizeDraft,
  type DeliveryDraft,
  type Interpretation,
  type OrderDraft,
  type OrderFieldKey,
} from "@dispatch/shared";
import { assignNextCourier, getBotConfig, quoteByDistance, type BotConfig, type Restaurant } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { notifyAssigned } from "@/bot/notify";
import { answerStatus } from "@/bot/status";
import { PICK_TRIP_PREFIX, applyTripUpdate, pickTrip, routeTripUpdate, tripUpdateFrom } from "@/bot/trip-updates";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import { createTrip, tripFromQuote } from "@/db/queries/trips";
import { geocodeAddress } from "@/services/google/geocode";
import { interpretMessage } from "@/services/openai/extract";
import { downloadImage, type DownloadedImage } from "@/services/whatsapp/client";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * La conversación con el restaurante (docs/BOT.md, «Flujo básico»):
 *
 *   dirección(es) → cotización con botón → confirmación (botón o escrita)
 *                 → se piden los datos que falten → un viaje por entrega → despacho
 *
 * Un pedido puede traer varias entregas (caso 4: «5 cada uno»): se cotizan
 * en un solo mensaje, se confirman juntas y cada una sale en su propio viaje.
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
  detalleDireccion: "la torre y el apartamento (o el número de casa)",
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

/** Google caído: el borrador se guarda (el asesor lo ve en el portal) y la
 *  conversación pasa a la central. */
async function escalateLocationDown(ctx: Context, draft: OrderDraft) {
  await updateConversation(ctx.conversation.id, {
    botPaused: true,
    escalationReason: "No se pudo ubicar la dirección: Google no respondió o no está configurado.",
    draft,
    failedAttempts: 0,
  });
  await say(ctx.conversation.id, ctx.message.phone, LOCATION_DOWN_MESSAGE, { replyTo: draft.mensajeOrigen });
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

/** Cómo se nombra una entrega en los mensajes: su barrio, o la dirección. */
function deliveryLabel(delivery: DeliveryDraft) {
  return delivery.barrio ?? delivery.direccionEntrega?.split(",")[0] ?? "la entrega";
}

/** Sin ubicación no hay precio, y Google no respondió (o no está
 *  configurado): no es culpa del restaurante, lo resuelve una persona. */
const LOCATION_DOWN_MESSAGE = "No puedo ubicar direcciones en este momento 🙏 Ya le paso tu pedido a la central.";

/**
 * La primera entrega del mensaje que trae algo distinto de lo que ya se
 * sabía en la misma posición: es lo que cambiaría un pedido ya creado.
 */
function changedDelivery(fields: Interpretation, known: OrderDraft) {
  for (let i = 0; i < fields.entregas.length; i++) {
    const incoming = fields.entregas[i];
    const before = known.entregas[i] ?? emptyDelivery();
    const differs = (Object.keys(incoming) as (keyof typeof incoming)[]).some((k) => incoming[k] != null && incoming[k] !== before[k]);
    if (differs) return { incoming, before };
  }
  return null;
}

/** Lo que falta para despachar, en palabras: del pedido y de cada entrega. */
function missingParts(quoted: DeliveryDraft[], config: BotConfig, restaurant: Restaurant | null, draft: OrderDraft) {
  const missingOrigin = !restaurant && !draft.origenRestaurante;
  const missing = quoted.map((d) => ({ d, keys: missingFields(d, config.requiredFields) })).filter((m) => m.keys.length);
  return [
    ...(missingOrigin ? [FIELD_LABEL.origenRestaurante] : []),
    ...missing.map((m) => {
      const labels = joinLabels(m.keys.map((k) => FIELD_LABEL[k]));
      return quoted.length === 1 ? labels : `${labels} del de ${deliveryLabel(m.d)}`;
    }),
  ];
}

/** Lo que cuesta una entrega, por distancia desde la recogida. `outOfRange`
 *  si pasa del tope de la agencia; `precio` null si la tabla por km está vacía. */
async function quoteDelivery(pickup: { lat: number; lng: number }, delivery: { lat: number; lng: number }, config: BotConfig) {
  const quote = await quoteByDistance(pickup, delivery);
  return { precio: quote.price, km: quote.km, outOfRange: config.maxKm !== null && quote.km > config.maxKm };
}

export async function handleRestaurant(ctx: Context) {
  const { conversation, message, restaurant } = ctx;
  const config = await getBotConfig();

  const known = normalizeDraft(conversation.draft);
  if (restaurant) known.origenRestaurante = restaurant.name;
  let draft: OrderDraft = structuredClone(known);
  let confirms = false;

  // 1. Lo que trae el mensaje.
  if (message.kind === "button") {
    if (message.buttonId.startsWith(PICK_TRIP_PREFIX)) {
      await pickTrip({ conversation, phone: message.phone }, message.buttonId, known);
      return;
    }
    if (message.buttonId !== CONFIRM_BUTTON_ID) return;
    if (!draft.entregas.some((d) => d.cotizacion)) {
      await say(conversation.id, message.phone, "No tengo un pedido por confirmar 🤔 Envíame la dirección de entrega para cotizarte.");
      return;
    }
    confirms = true;
  } else if (message.kind === "location") {
    // El pin de WhatsApp: coordenadas exactas, sin pagar geocodificación. Va
    // a la última entrega si todavía no está ubicada; si no, es una nueva.
    const last = draft.entregas[draft.entregas.length - 1];
    const target = last && !last.ubicacionEntrega ? last : emptyDelivery();
    if (target !== last) draft.entregas.push(target);
    const address = message.label ?? target.direccionEntrega ?? "Ubicación enviada por WhatsApp";
    Object.assign(target, { direccionEntrega: address, direccionUbicada: address, ubicacionEntrega: { lat: message.lat, lng: message.lng }, cotizacion: null });
  } else if (message.kind === "text") {
    const images = (await Promise.all((message.images ?? []).map(downloadImage))).filter((i): i is DownloadedImage => !!i);
    if (message.images?.length && !images.length && !message.text.trim()) {
      await say(conversation.id, message.phone, "No pude abrir la imagen 🙏 ¿Me escribes la dirección de entrega?");
      return;
    }
    const extraction = await interpretMessage(message.text, draft, images);
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

    const quoted = message.replyTo ? await tripFromQuote(conversation.id, message.replyTo) : null;

    // Consultas: no cambian el pedido en curso, solo se responden.
    if (extraction.query === "estado") {
      await answerStatus(conversation, message.phone, quoted);
      return;
    }
    const asksAddress = !extraction.fields.entregas.some((e) => e.direccionEntrega) && !known.entregas.some((e) => e.direccionEntrega);
    if (extraction.query === "cobertura" && asksAddress) {
      await say(conversation.id, message.phone, "Envíame la dirección o la ubicación y te digo si llegamos y cuánto vale 🛵");
      return;
    }

    // ¿Habla de un pedido ya creado? Si citó uno de sus mensajes, de ese; si
    // no hay un pedido a medio armar y el mensaje no trae una dirección,
    // de sus pedidos abiertos (casos 9 y 12: «ya está listo»).
    const changed = changedDelivery(extraction.fields, known);
    const update = changed ? tripUpdateFrom(changed.incoming, changed.before, message.timestamp) : null;
    const newAddress = !!changed?.incoming.direccionEntrega && changed.incoming.direccionEntrega !== changed.before.direccionEntrega;
    const updateCtx = { conversation, phone: message.phone };
    if (quoted && newAddress) {
      await escalate(ctx, `Pidió cambiar la dirección del pedido ${quoted.code}, que ya estaba creado.`);
      return;
    }
    if (quoted && update) {
      await applyTripUpdate(updateCtx, quoted, update);
      return;
    }
    if (!quoted && update && !newAddress && known.entregas.length === 0 && (await routeTripUpdate(updateCtx, update, known))) return;

    draft = mergeTripFields(draft, extraction.fields);
    if (restaurant) draft.origenRestaurante = restaurant.name;
    // El modelo repite el tiempo ya capturado: solo cuando cambia es un dato
    // nuevo, y se cuenta desde este mensaje.
    let timeChanged = false;
    draft.entregas.forEach((d, i) => {
      if (d.listoEnMinutos != null && d.listoEnMinutos !== known.entregas[i]?.listoEnMinutos) {
        d.listoDesde = message.timestamp.toISOString();
        timeChanged = true;
      }
    });
    // Dar el tiempo después de la cotización también es aceptar el servicio
    // (así confirman los restaurantes hoy: «5 mil» → «en 8 minutos»).
    confirms = known.entregas.some((d) => d.cotizacion) && (extraction.confirms || timeChanged);
  } else {
    await say(conversation.id, message.phone, "Por ahora leo mensajes de texto y ubicaciones 🙏 ¿Me escribes la dirección de entrega?");
    return;
  }

  const located = (d: OrderDraft) => d.entregas.filter((e) => e.ubicacionEntrega).length;
  const progressed = countFields(draft) > countFields(known) || located(draft) > located(known);

  // 2. Sin dirección no hay cotización: es lo primero que se pide. Una entrega
  // sin dirección (solo un teléfono suelto, por ejemplo) espera a tenerla.
  const deliveries = draft.entregas.filter((d) => d.direccionEntrega);
  if (!deliveries.length) {
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

  // El mensaje que trajo la primera dirección es el que se cita en los avisos.
  if (!draft.mensajeOrigen) draft.mensajeOrigen = message.waMessageId;
  const replyTo = draft.mensajeOrigen;

  // 3. Ubicar la recogida (si el restaurante no está registrado) y cada
  // dirección de entrega, una sola vez por dirección. Sin ubicación no hay precio.
  let pickupLocation = restaurant?.knownPickupLocation ?? draft.ubicacionRecogida ?? null;
  if (!restaurant?.knownPickupLocation && draft.origenRestaurante && draft.origenRestaurante !== draft.recogidaUbicada) {
    const geocoded = await geocodeAddress(draft.origenRestaurante);
    if (geocoded.kind === "failed" || geocoded.kind === "disabled") {
      await escalateLocationDown(ctx, draft);
      return;
    }
    pickupLocation = geocoded.kind === "found" ? geocoded.location : null;
    draft.ubicacionRecogida = pickupLocation;
    draft.recogidaUbicada = draft.origenRestaurante;
    draft.entregas.forEach((d) => (d.cotizacion = null));
  }
  if (!pickupLocation) {
    const asked = draft.origenRestaurante
      ? `No encuentro «${draft.origenRestaurante}» en el mapa 🗺️ ¿Me escribes la dirección de recogida con el número completo y el barrio?`
      : "¿Desde qué dirección se recoge? (con el número completo y el barrio)";
    if (await countAttempt(ctx, draft, progressed, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos sin dirección de recogida que se pueda ubicar.`)) {
      await say(conversation.id, message.phone, asked, { replyTo: draft.mensajeOrigen });
    }
    return;
  }

  const notFound: DeliveryDraft[] = [];
  for (const d of deliveries) {
    if (d.direccionEntrega === d.direccionUbicada && d.ubicacionEntrega) continue;
    const geocoded = await geocodeAddress(d.direccionEntrega!);
    if (geocoded.kind === "failed" || geocoded.kind === "disabled") {
      await escalateLocationDown(ctx, draft);
      return;
    }
    if (geocoded.kind === "not_found") {
      d.direccionUbicada = null;
      notFound.push(d);
      continue;
    }
    d.ubicacionEntrega = geocoded.location;
    if (geocoded.neighborhood) d.barrio = geocoded.neighborhood;
    d.direccionUbicada = d.direccionEntrega;
    d.cotizacion = null;
  }
  if (notFound.length) {
    const list = notFound.map((d) => `«${d.direccionEntrega}»`).join(" ni ");
    if (await countAttempt(ctx, draft, false, `No se pudo ubicar en el mapa: ${notFound.map((d) => d.direccionEntrega).join(" / ")}`)) {
      await say(conversation.id, message.phone, `No encuentro ${list} en el mapa 🗺️ ¿Me la confirmas con el número completo y el barrio? También puedes enviarme la ubicación.`, {
        replyTo,
      });
    }
    return;
  }

  // 4. Cotizar lo que no tenga precio. Un precio nuevo siempre se muestra y se
  // confirma, aunque el restaurante ya hubiera confirmado lo anterior.
  const outOfRange: { delivery: DeliveryDraft; km: number }[] = [];
  let newQuote = false;
  for (const d of deliveries) {
    if (d.cotizacion) continue;
    const quote = await quoteDelivery(pickupLocation, d.ubicacionEntrega!, config);
    if (quote.precio === null) {
      await escalate(ctx, "La tabla de tarifas por km está vacía: no hay con qué cotizar. Llénala en el portal (Tarifas).");
      return;
    }
    if (quote.outOfRange) {
      outOfRange.push({ delivery: d, km: quote.km! });
      continue;
    }
    d.cotizacion = { precio: quote.precio, km: quote.km };
    newQuote = true;
  }
  if (outOfRange.length) {
    draft.entregas = draft.entregas.filter((d) => !outOfRange.some((o) => o.delivery === d));
  }
  const coverageNote = outOfRange
    .map((o) => `Hasta ${deliveryLabel(o.delivery)} no tenemos cobertura 🙏 (${o.km} km, llegamos hasta ${config.maxKm} km).`)
    .join("\n");
  const quoted = draft.entregas.filter((d) => d.cotizacion);

  if (!quoted.length) {
    await save(ctx, null);
    await say(conversation.id, message.phone, coverageNote, { replyTo });
    return;
  }

  if (newQuote || outOfRange.length) {
    draft.etapa = "cotizado";
    await save(ctx, draft);
    const total = quoted.reduce((sum, d) => sum + d.cotizacion!.precio, 0);
    const body =
      quoted.length === 1
        ? `Serían ${cop(total)} hasta ${deliveryLabel(quoted[0])} 🛵`
        : `Serían ${quoted.length} domicilios 🛵\n${quoted.map((d) => `• ${deliveryLabel(d)}: ${cop(d.cotizacion!.precio)}`).join("\n")}\nTotal: ${cop(total)}`;
    // Lo que falte se pide en la misma cotización: el restaurante confirma y
    // completa en una sola respuesta, sin un mensaje más de ida y vuelta.
    const pending = missingParts(quoted, config, restaurant, draft);
    const ask = pending.length ? `\nPara despacharlo envíame ${joinLabels(pending)}.` : "";
    const text = [body + ask, coverageNote].filter(Boolean).join("\n\n");
    await say(conversation.id, message.phone, text, {
      replyTo,
      buttons: [{ id: CONFIRM_BUTTON_ID, title: quoted.length === 1 ? "Confirmar servicio" : `Confirmar los ${quoted.length}` }],
    });
    return;
  }

  // 5. Esperando confirmación.
  if (confirms) draft.etapa = "confirmado";
  const total = quoted.reduce((sum, d) => sum + d.cotizacion!.precio, 0);
  if (draft.etapa !== "confirmado") {
    if (await countAttempt(ctx, draft, progressed, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos sin confirmar el servicio.`)) {
      await say(conversation.id, message.phone, `Anotado ✅ Confirma el servicio de ${cop(total)} y pido la moto.`, {
        replyTo,
        buttons: [{ id: CONFIRM_BUTTON_ID, title: quoted.length === 1 ? "Confirmar servicio" : `Confirmar los ${quoted.length}` }],
      });
    }
    return;
  }

  // 6. Confirmado: lo que falte según la agencia, entrega por entrega.
  const parts = missingParts(quoted, config, restaurant, draft);
  if (parts.length) {
    if (await countAttempt(ctx, draft, progressed || confirms, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos sin los datos que faltan.`)) {
      await say(conversation.id, message.phone, `Listo ✅ Para pedir la moto me falta ${joinLabels(parts)}.`, { replyTo });
    }
    return;
  }

  // 7. Completo: un viaje por entrega, y cada uno se despacha.
  await save(ctx, null);
  for (const d of quoted) {
    const trip = await createTrip(
      conversation.id,
      { origenRestaurante: draft.origenRestaurante!, mensajeOrigen: draft.mensajeOrigen ?? null },
      d,
      d.cotizacion!.precio,
      restaurant ? null : { address: draft.origenRestaurante!, location: pickupLocation },
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
}
