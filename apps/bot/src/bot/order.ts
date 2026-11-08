import {
  ESCALATION_MESSAGE,
  MAX_CLARIFICATION_ATTEMPTS,
  countFields,
  emptyDelivery,
  fullAddress,
  mergeTripFields,
  missingFields,
  namedAsDestination,
  normalizeDraft,
  type DeliveryDraft,
  type DoubtfulField,
  type Interpretation,
  type OrderDraft,
  type OrderFieldKey,
} from "@dispatch/shared";
import { getBotConfig, getEngineConfig, linkRestaurantPhone, quoteByDistance, saveRestaurant, type BotConfig, type Restaurant } from "@dispatch/shared/db";

import { say } from "@/bot/messaging";
import { dispatchNewTrip } from "@/dispatch/engine";
import { notifyAssigned } from "@/bot/notify";
import { recognizeRestaurant } from "@/bot/restaurant-identity";
import { answerStatus, confirmedText, estimatePickup } from "@/bot/status";
import { PICK_TRIP_PREFIX, applyTripUpdate, pickTrip, routeTripUpdate, tripUpdateFrom } from "@/bot/trip-updates";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import { createTrip, tripFromCodeInText, tripFromQuote } from "@/db/queries/trips";
import { geocodeAddress, type GeocodeOutcome } from "@/services/google/geocode";
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
export const IDENTITY_YES_BUTTON_ID = "identidad_si";
export const IDENTITY_NO_BUTTON_ID = "identidad_no";

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

/** Algo no cuadra con quién escribe: lo resuelve la central. El borrador se
 *  guarda, para retomar el pedido cuando el bot vuelva a este chat. */
async function escalateIdentity(ctx: Context, draft: OrderDraft, reason: string) {
  await updateConversation(ctx.conversation.id, { botPaused: true, escalationReason: reason, draft, failedAttempts: 0 });
  await say(ctx.conversation.id, ctx.message.phone, ESCALATION_MESSAGE);
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

function formatPhone(phone: string) {
  const d = phone.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : phone;
}

/**
 * Lo que el bot entendió de una entrega, para que el restaurante lo revise
 * antes de pedir la moto. Lo dudoso va con ❓.
 */
export function readBack(d: DeliveryDraft) {
  const doubt = (...keys: DoubtfulField[]) => (keys.some((k) => d.dudas?.includes(k)) ? " ❓" : "");
  const customer = [
    d.nombreCliente && `${d.nombreCliente}${doubt("nombreCliente")}`,
    d.telefonoCliente && `📞 ${formatPhone(d.telefonoCliente)}${doubt("telefonoCliente")}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const ready =
    d.listoEnMinutos == null ? null : `⏱️ ${d.listoEnMinutos === 0 ? "Ya está lista" : `Lista en ${d.listoEnMinutos} min`}${doubt("listoEnMinutos")}`;
  return [
    `📍 ${fullAddress(d)}${doubt("direccionEntrega", "detalleDireccion")}`,
    customer ? `👤 ${customer}` : null,
    ready,
    d.notas ? `📝 Para el domiciliario: ${d.notas}${doubt("notas")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** La entrega trae algo más que la dirección: vale la pena mostrársela. */
export function hasOrderData(d: DeliveryDraft) {
  return !!(d.nombreCliente || d.telefonoCliente || d.detalleDireccion || d.notas);
}

/** El resumen de todas las entregas, para revisar. */
export function readBackAll(deliveries: DeliveryDraft[], fromImage: boolean) {
  const intro = fromImage ? "Esto leí en la imagen 👇" : "Esto entendí del pedido 👇";
  const body = deliveries.length === 1 ? readBack(deliveries[0]) : deliveries.map((d, i) => `*${i + 1}.* ${readBack(d)}`).join("\n\n");
  const legend = deliveries.some((d) => d.dudas?.length) ? "\n❓ = no estoy seguro de ese dato." : "";
  return `${intro}\n\n${body}${legend}`;
}

/**
 * El nombre y la dirección de un restaurante nuevo, a partir de lo que dijo
 * («Pizza Nona, Calle 10 # 5-20, San Fernando») y su nombre de WhatsApp. Si
 * lo primero que escribió es su nombre, se separa de la dirección; si no, el
 * nombre es el de WhatsApp (o, sin él, la primera parte de lo que escribió).
 */
export function splitPickup(said: string, profileName: string | null): { name: string; address: string } {
  const parts = said.split(",").map((p) => p.trim()).filter(Boolean);
  const first = parts[0] ?? said.trim();
  const looksLikeAddress = /\d|^(calle|cl|carrera|cra|kr|cr|avenida|av|diagonal|dg|transversal|tv)\b/i.test(first);
  const profile = profileName?.trim() || null;
  if (parts.length > 1 && !looksLikeAddress) return { name: profile ?? first, address: parts.slice(1).join(", ") };
  return { name: profile ?? first, address: said.trim() };
}

const CHECK_DATA ="¿Los datos están bien? Si algo no es, escríbeme el dato correcto.";

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
    // Las dudas del modelo no son un dato del pedido: no cuentan como cambio.
    const differs = (Object.keys(incoming) as (keyof typeof incoming)[]).some((k) => k !== "dudas" && incoming[k] != null && incoming[k] !== before[k]);
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

/**
 * El mensaje con el precio de lo cotizado. Si solo preguntó el precio, el
 * precio y ya: ni botón ni «¿queda confirmado?» (si lo quiere, lo dice). Si
 * pide el servicio, el precio, la pregunta directa y lo que falte, para
 * confirmar y completar en una sola respuesta.
 */
export function quoteMessage(
  draft: OrderDraft,
  opts: { config: BotConfig; restaurant: Restaurant | null; fromImage?: boolean; coverageNote?: string; intro?: string },
): { text: string; buttons?: { id: string; title: string }[] } {
  const quoted = draft.entregas.filter((d) => d.cotizacion);
  const total = quoted.reduce((sum, d) => sum + d.cotizacion!.precio, 0);
  const list = quoted.map((d) => `• ${deliveryLabel(d)}: ${cop(d.cotizacion!.precio)}`).join("\n");
  const join = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join("\n\n");

  if (draft.soloPrecio) {
    const body =
      quoted.length === 1 ? `Hasta ${deliveryLabel(quoted[0])} el domicilio vale ${cop(total)} 🛵` : `Los domicilios quedan así 🛵\n${list}\nTotal: ${cop(total)}`;
    return { text: join([opts.intro, body, opts.coverageNote]) };
  }

  const body = quoted.length === 1 ? `Serían ${cop(total)} hasta ${deliveryLabel(quoted[0])} 🛵` : `Serían ${quoted.length} domicilios 🛵\n${list}\nTotal: ${cop(total)}`;
  const pending = missingParts(quoted, opts.config, opts.restaurant, draft);
  const question = `${quoted.length === 1 ? "¿Queda confirmado?" : "¿Quedan confirmados?"}${pending.length ? ` Si es así, envíame también ${joinLabels(pending)}.` : ""}`;
  // Mandó el pedido con los datos del cliente: se le muestra cómo quedó
  // separado (dirección, cliente, tiempo, indicaciones) para que confirme
  // que está todo. Con solo una dirección no hay nada que revisar.
  const showData = draft.verificar || quoted.some(hasOrderData);
  return {
    text: join([
      opts.intro,
      showData ? readBackAll(quoted, !!opts.fromImage) : null,
      [body, showData ? CHECK_DATA : null, question].filter(Boolean).join("\n"),
      opts.coverageNote,
    ]),
    buttons: [{ id: CONFIRM_BUTTON_ID, title: quoted.length === 1 ? "Confirmar servicio" : `Confirmar los ${quoted.length}` }],
  };
}

/** Empieza así el motivo de una conversación pausada porque el bot le
 *  preguntó una dirección a la central: el portal la reconoce por esto. */
export const ADVISOR_QUERY_REASON = "Consulta de dirección:";

/**
 * El mapa no ubicó una o más direcciones (o no respondió): en vez de insistirle
 * al restaurante, el bot le pregunta a la central si la dirección es válida y
 * cuánto vale. El borrador se conserva; mientras el asesor responde en el
 * portal, el bot no contesta en ese chat. La respuesta la aplica `advisor.ts`.
 */
async function askAdvisor(ctx: Context, draft: OrderDraft, pending: DeliveryDraft[], mapDown: boolean) {
  draft.consultaAsesor = { entregas: pending.map((d) => draft.entregas.indexOf(d)), desde: new Date().toISOString() };
  const list = pending.map((d) => `«${fullAddress(d)}»`).join(" y ");
  const why = mapDown ? "el mapa no respondió" : "no la encuentro en el mapa";
  await updateConversation(ctx.conversation.id, {
    botPaused: true,
    escalationReason: `${ADVISOR_QUERY_REASON} ${why}. ¿Es válida ${list} y cuánto vale el domicilio?`,
    draft,
    failedAttempts: 0,
  });
  const text = mapDown
    ? `No puedo ubicar direcciones en este momento 🙏 Ya le pregunto a la central cuánto vale el domicilio a ${list}. Te aviso en un momento.`
    : `No logro ubicar ${list} en el mapa 🗺️ Ya le pregunto a la central si la dirección está bien y cuánto vale el domicilio. Te aviso en un momento 🙏`;
  await say(ctx.conversation.id, ctx.message.phone, text, { replyTo: draft.mensajeOrigen });
}

export async function handleRestaurant(ctx: Context) {
  const { conversation, message } = ctx;
  let { restaurant } = ctx;
  const config = await getBotConfig();

  const known = normalizeDraft(conversation.draft);
  if (restaurant) known.origenRestaurante = restaurant.name;
  let draft: OrderDraft = structuredClone(known);
  let confirms = false;
  let fromImage = false;
  let saidName: string | null = null;

  // Se le preguntó si es el restaurante de este número. Solo un «no» lo pasa a
  // la central; cualquier otra respuesta sigue con el pedido y no se repite.
  const answersIdentity = !!known.preguntaIdentidad;
  if (answersIdentity) {
    draft.preguntaIdentidad = false;
    const denied = message.kind === "button" ? message.buttonId === IDENTITY_NO_BUTTON_ID : message.kind === "text" && /^\s*no\b/i.test(message.text);
    if (denied) {
      await escalateIdentity(ctx, draft, `Escribe desde el número de ${restaurant?.name ?? "un restaurante registrado"}, pero dice que no es ese restaurante.`);
      return;
    }
  }

  // 1. Lo que trae el mensaje.
  if (message.kind === "button") {
    if (message.buttonId.startsWith(PICK_TRIP_PREFIX)) {
      await pickTrip({ conversation, phone: message.phone }, message.buttonId, known);
      return;
    }
    if (message.buttonId === IDENTITY_YES_BUTTON_ID) {
      if (!answersIdentity) return;
    } else {
      if (message.buttonId !== CONFIRM_BUTTON_ID) return;
      if (!draft.entregas.some((d) => d.cotizacion)) {
        await say(conversation.id, message.phone, "No tengo un pedido por confirmar 🤔 Envíame la dirección de entrega para cotizarte.");
        return;
      }
      confirms = true;
    }
  } else if (message.kind === "location") {
    // El pin de WhatsApp: coordenadas exactas, sin pagar geocodificación. Va
    // a la última entrega si todavía no está ubicada; si no, es una nueva.
    // Después de solo preguntar un precio, un pin es un pedido aparte.
    if (draft.soloPrecio) draft = { ...draft, etapa: "recibiendo", entregas: [], mensajeOrigen: null, soloPrecio: false };
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

    // De qué pedido habla: el que citó o, si no citó, el que nombra por su
    // código («¿ya llegó el B-12?»).
    const quoted =
      (message.replyTo ? await tripFromQuote(conversation.id, message.replyTo) : null) ?? (await tripFromCodeInText(conversation.id, message.text));

    saidName = extraction.fields.nombreRestaurante ?? null;
    if (saidName && namedAsDestination(message.text, saidName)) saidName = null;

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

    // ¿Solo pregunta el precio o pide el servicio? Preguntar si llegan a una
    // dirección también es solo cotizar.
    const priceOnly = extraction.intent === "cotizar" || extraction.query === "cobertura";
    // Ya se le dio solo un precio y ahora pregunta (o pide) a otra dirección:
    // es otra cotización, no un segundo domicilio. Se empieza de nuevo con lo
    // que trae este mensaje; la recogida se conserva.
    let fields = extraction.fields;
    if (known.soloPrecio && !extraction.confirms) {
      const fresh = fields.entregas.filter((e) => e.direccionEntrega && !known.entregas.some((k) => k.direccionEntrega === e.direccionEntrega));
      if (fresh.length) {
        draft = { ...draft, etapa: "recibiendo", entregas: [], mensajeOrigen: null, verificar: false };
        fields = { ...fields, entregas: fresh };
      }
    }
    draft = mergeTripFields(draft, fields);
    draft.soloPrecio = priceOnly || (extraction.intent !== "pedir" && !!known.soloPrecio && draft.entregas.length > 0);
    if (restaurant) draft.origenRestaurante = restaurant.name;
    // Leído de una foto, o con algún dato dudoso: antes de pedir la moto, el
    // restaurante revisa lo que se entendió.
    fromImage = images.length > 0;
    if (fromImage || extraction.fields.entregas.some((e) => e.dudas?.length)) draft.verificar = true;
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

  // Quién escribe: su número y su nombre (docs/BOT.md, «Reconocer al restaurante»).
  const recognition = await recognizeRestaurant({ byPhone: restaurant, saidName, profileName: conversation.displayName, reviewed: draft.nombresRevisados ?? [] });
  if (recognition.reviewed) draft.nombresRevisados = [...(draft.nombresRevisados ?? []), recognition.reviewed];
  const identity = recognition.identity;
  if (identity.kind === "confirm") {
    draft.preguntaIdentidad = true;
    await save(ctx, draft);
    await say(conversation.id, message.phone, `¿Hablo con ${recognition.restaurant!.name}?`, {
      buttons: [
        { id: IDENTITY_YES_BUTTON_ID, title: "Sí" },
        { id: IDENTITY_NO_BUTTON_ID, title: "No" },
      ],
    });
    return;
  }
  if (identity.kind === "other-number") {
    await escalateIdentity(ctx, draft, `Escribe desde un número nuevo con el nombre de ${recognition.restaurant!.name}, que tiene otro número registrado.`);
    return;
  }
  if (identity.kind === "link") {
    const linked = await linkRestaurantPhone(identity.restaurantId, message.phone);
    if (!linked) {
      await escalateIdentity(ctx, draft, `Parece ser ${recognition.restaurant!.name}, pero no se le pudo guardar este número: ya es de otro restaurante.`);
      return;
    }
    restaurant = linked;
    // Lo que se haya cotizado era desde otra recogida.
    draft.origenRestaurante = linked.name;
    draft.ubicacionRecogida = null;
    draft.recogidaUbicada = null;
    draft.entregas.forEach((d) => Object.assign(d, { cotizacion: null, validadaPorAsesor: false }));
    draft.etapa = "recibiendo";
    confirms = false;
    await say(conversation.id, message.phone, `📌 Te reconocí como ${linked.name}. Recogemos en ${linked.knownPickupAddress}. Si no es así, avísale a la central.`);
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
    // Otra recogida: todo se vuelve a medir, también lo que validó el asesor.
    draft.entregas.forEach((d) => Object.assign(d, { cotizacion: null, validadaPorAsesor: false }));
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

  // Lo que el mapa no ubique (o si no responde) se le pregunta a la central:
  // si la dirección es válida y cuánto vale.
  const notFound: DeliveryDraft[] = [];
  let mapDown = false;
  for (const d of deliveries) {
    const unchanged = d.direccionEntrega === d.direccionUbicada;
    if (unchanged && (d.ubicacionEntrega || d.validadaPorAsesor)) continue;
    const geocoded: GeocodeOutcome = mapDown ? { kind: "failed" } : await geocodeAddress(d.direccionEntrega!);
    if (geocoded.kind !== "found") {
      mapDown ||= geocoded.kind === "failed" || geocoded.kind === "disabled";
      Object.assign(d, { direccionUbicada: null, ubicacionEntrega: null, validadaPorAsesor: false, cotizacion: null });
      notFound.push(d);
      continue;
    }
    d.ubicacionEntrega = geocoded.location;
    if (geocoded.neighborhood) d.barrio = geocoded.neighborhood;
    d.direccionUbicada = d.direccionEntrega;
    d.validadaPorAsesor = false;
    d.cotizacion = null;
  }
  if (notFound.length) {
    await askAdvisor(ctx, draft, notFound, mapDown);
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
    const quote = quoteMessage(draft, { config, restaurant, fromImage, coverageNote });
    await say(conversation.id, message.phone, quote.text, { replyTo, buttons: quote.buttons });
    return;
  }

  // 5. Esperando confirmación. Confirmar es aceptar el precio y, si se le
  // mostraron, también los datos: dejan de ser dudosos.
  if (confirms) {
    draft.etapa = "confirmado";
    draft.verificar = false;
    draft.soloPrecio = false;
    draft.entregas.forEach((d) => (d.dudas = null));
  }
  const total = quoted.reduce((sum, d) => sum + d.cotizacion!.precio, 0);
  // Solo había preguntado el precio y no decidió mandarlo («gracias», «ok»):
  // no se le insiste ni cuenta como intento. El precio queda guardado por si
  // después dice «dale».
  if (draft.etapa !== "confirmado" && draft.soloPrecio) {
    await save(ctx, draft);
    return;
  }
  // Un dato dudoso que llegó después de confirmar (un celular con un dígito
  // de menos, una dirección que no cuadra) también se confirma antes de
  // pedir la moto: es mejor preguntar que mandar al domiciliario a otro lado.
  if (draft.etapa !== "confirmado" || draft.verificar) {
    if (await countAttempt(ctx, draft, progressed, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos sin confirmar el servicio.`)) {
      // Revisando datos: se le muestra cómo quedaron después de su corrección.
      const text = draft.verificar
        ? `${readBackAll(quoted, false)}\n\nAnotado ✅ ${CHECK_DATA}\nSi todo está bien, ¿queda confirmado el servicio de ${cop(total)}?`
        : `Anotado ✅ ¿Queda confirmado el servicio de ${cop(total)}?`;
      await say(conversation.id, message.phone, text, {
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

  // Un número nuevo: su recogida queda guardada con el primer pedido
  // confirmado. Desde el próximo, el bot lo reconoce por su número y ya no la
  // pregunta.
  if (!restaurant && draft.origenRestaurante) {
    const pickup = splitPickup(draft.origenRestaurante, conversation.displayName);
    restaurant = (await saveRestaurant({ phone: message.phone, name: pickup.name, pickupAddress: pickup.address, pickupLocation })).restaurant;
    await say(
      conversation.id,
      message.phone,
      `📌 Guardé tu dirección de recogida: ${pickup.address}. La próxima vez no tienes que enviarla. Si cambia, avísale a la central.`,
    );
  }
  for (const d of quoted) {
    const trip = await createTrip(
      conversation.id,
      { origenRestaurante: restaurant?.name ?? draft.origenRestaurante!, mensajeOrigen: draft.mensajeOrigen ?? null },
      d,
      d.cotizacion!.precio,
      restaurant ? null : { address: draft.origenRestaurante!, location: pickupLocation },
      restaurant,
    );
    // El restaurante siempre queda confirmado y con un tiempo, haya moto
    // libre o no: la espera por eficiencia del despacho no es suya. Con moto
    // ya, un solo mensaje con quién va; sin moto, la confirmación sale ya
    // y quién va llega después (notifyAssigned).
    const engineLeads = (await getEngineConfig()).mode === "auto";
    if (await dispatchNewTrip(trip.id)) {
      await notifyAssigned(trip.id, { atConfirmation: true });
    } else {
      // Con el engine, esperar es a propósito (que la moto llegue justo cuando
      // la comida esté lista), no una demora por la que pedir disculpas.
      const courier = engineLeads ? { lat: null, lng: null, locationUpdatedAt: null } : null;
      const estimate = estimatePickup({ readyAt: trip.readyAt, pickup: trip.pickupLocation ?? null, courier });
      await say(conversation.id, message.phone, confirmedText(trip.code, estimate, null, cop(trip.deliveryFee)), {
        replyTo: trip.sourceWaMessageId,
        tripId: trip.id,
      });
    }
  }
}
