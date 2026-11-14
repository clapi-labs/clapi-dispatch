import {
  ESCALATION_MESSAGE,
  MAX_CLARIFICATION_ATTEMPTS,
  closedMessage,
  closedNoticeDue,
  countFields,
  emptyDelivery,
  fullAddress,
  isOpen,
  mergeTripFields,
  missingFields,
  namedAsDestination,
  normalizeDraft,
  normalizeName,
  removeDeliveries,
  type DeliveryDraft,
  type DoubtfulField,
  type Interpretation,
  type OrderDraft,
  type OrderFieldKey,
  type FareSplit,
  type RoadSource,
} from "@dispatch/shared";
import {
  getBotConfig,
  getEngineConfig,
  getServiceHours,
  hoursFor,
  linkRestaurantPhone,
  listServiceZones,
  quoteByDistance,
  saveRestaurant,
  type BotConfig,
  type Restaurant,
  type ServiceZone,
} from "@dispatch/shared/db";

import { coverageAt, coverageQueryReason, nearEdgeText, noServiceText } from "@/bot/coverage";
import { say } from "@/bot/messaging";
import { dispatchNewTrip } from "@/dispatch/engine";
import { notifyAssigned } from "@/bot/notify";
import { recognizeRestaurant } from "@/bot/restaurant-identity";
import { pinAddress } from "@/bot/turns";
import { answerStatus, confirmedText, estimatePickup } from "@/bot/status";
import { PICK_TRIP_PREFIX, applyTripUpdate, pickTrip, routeTripUpdate, tripUpdateFrom } from "@/bot/trip-updates";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import { createTrip, openTrips, tripFromCodeInText, tripFromQuote } from "@/db/queries/trips";
import { geocodeAddress, type GeocodeOutcome } from "@/services/google/geocode";
import { interpretMessage } from "@/services/openai/extract";
import { downloadImage, type DownloadedImage } from "@/services/whatsapp/client";
import type { IncomingMessage, TurnPin } from "@/services/whatsapp/types";

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

/** Cómo se pide cada dato en el formato que llena el restaurante, en el
 *  orden en que se pide. */
const TEMPLATE_LABEL: Record<OrderFieldKey, string> = {
  origenRestaurante: "Dirección de recogida",
  direccionEntrega: "Dirección de entrega",
  nombreCliente: "Nombre del cliente",
  telefonoCliente: "Teléfono del cliente",
  detalleDireccion: "Detalle (torre, apto, local o casa, si aplica)",
  valorACobrar: "Valor a cobrar",
  metodoPago: "Pago (efectivo o transferencia)",
  listoEnMinutos: "Tiempo en que está listo el pedido",
  notas: "Indicaciones",
};
const TEMPLATE_ORDER = Object.keys(TEMPLATE_LABEL) as OrderFieldKey[];

const TECHNICAL_ERROR_MESSAGE =
  "Tuve un problema técnico leyendo tu mensaje 🙏 No se perdió nada de lo que ya me diste. ¿Me lo reenvías en un momento?";

function cop(n: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
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

/**
 * Fuera de horario (docs/BOT.md, «Horario»): el pedido no se recibe, lo que
 * estuviera a medio armar se descarta y el chat no pasa a la central. El aviso
 * sale una vez por cierre; si sigue escribiendo esa noche, no se repite.
 */
async function closedForOrders(ctx: Context, opensAt: string, now: Date) {
  const due = closedNoticeDue(now, opensAt, ctx.conversation.closedNoticeAt);
  await updateConversation(ctx.conversation.id, { draft: null, failedAttempts: 0, ...(due ? { closedNoticeAt: now } : {}) });
  if (due) await say(ctx.conversation.id, ctx.message.phone, closedMessage(now, opensAt));
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

/**
 * Lo que falta para pedir la moto, como un formato para llenar y mandar en un
 * solo mensaje. Con varias entregas, un bloque por cada una que le falte algo.
 * El detalle (torre y apto) va siempre que no lo haya dado, «si aplica»: que
 * sea obligatorio lo decide `missingFields`, pero no siempre se sabe que es un
 * conjunto. `null` si no falta nada.
 */
function dataRequest(quoted: DeliveryDraft[], config: BotConfig, restaurant: Restaurant | null, draft: OrderDraft) {
  const missingOrigin = !restaurant && !draft.origenRestaurante;
  const missing = quoted
    .map((d) => {
      const keys: OrderFieldKey[] = missingFields(d, config.requiredFields);
      if (keys.length && !d.detalleDireccion && !keys.includes("detalleDireccion")) keys.push("detalleDireccion");
      return { d, keys };
    })
    .filter((m) => m.keys.length);
  if (!missingOrigin && !missing.length) return null;
  const lines = (keys: OrderFieldKey[]) =>
    [...keys]
      .sort((a, b) => TEMPLATE_ORDER.indexOf(a) - TEMPLATE_ORDER.indexOf(b))
      .map((k) => `${TEMPLATE_LABEL[k]}:`)
      .join("\n");
  const blocks = [
    missingOrigin ? lines(["origenRestaurante"]) : null,
    ...missing.map((m) => (quoted.length === 1 ? lines(m.keys) : `*${deliveryLabel(m.d)}*\n${lines(m.keys)}`)),
  ];
  return `Para pedir ${quoted.length === 1 ? "la moto" : "las motos"}, envíame en un solo mensaje:\n\n${blocks.filter(Boolean).join("\n\n")}`;
}

/** El pedido completo tal como se le mostró para confirmar: si cambia algo,
 *  se le vuelve a mostrar antes de pedir la moto. */
function summaryOf(quoted: DeliveryDraft[]) {
  return `${readBackAll(quoted, false)}\n${quoted.map((d) => d.cotizacion?.precio).join(",")}`;
}

/** Lo que cuesta una entrega: la tabla por km desde la recogida más el ajuste
 *  de la zona de la entrega. `outOfRange` si pasa del tope de la agencia;
 *  `precio` null si la tabla por km está vacía. */
async function quoteDelivery(pickup: { lat: number; lng: number }, delivery: { lat: number; lng: number }, config: BotConfig, zones: ServiceZone[]) {
  const quote = await quoteByDistance(pickup, delivery, { zones });
  const b = quote.breakdown;
  return {
    precio: quote.price,
    km: quote.km,
    fuente: quote.source,
    desglose: b ? { tabla: b.table, ajuste: b.adjustment, zona: b.zone?.name ?? null } : null,
    outOfRange: config.maxKm !== null && quote.km > config.maxKm,
  };
}

/**
 * La respuesta con el precio. Mientras falten datos: el precio y el formato
 * con lo que falta, sin botón (confirmar sin los datos no pide ninguna moto).
 * Con el pedido completo: lo que se entendió, el precio y el botón para
 * confirmar; `summary` es lo que se le mostró (`summaryOf`). `withPrice`
 * false: ya se le dio ese precio, así que solo se pide lo que falta.
 */
export function quoteMessage(
  draft: OrderDraft,
  opts: { config: BotConfig; restaurant: Restaurant | null; fromImage?: boolean; coverageNote?: string; intro?: string; withPrice?: boolean },
): { text: string; buttons?: { id: string; title: string }[]; summary?: string } {
  const quoted = draft.entregas.filter((d) => d.cotizacion);
  const total = quoted.reduce((sum, d) => sum + d.cotizacion!.precio, 0);
  const list = quoted.map((d) => `• ${deliveryLabel(d)}: ${cop(d.cotizacion!.precio)}`).join("\n");
  const join = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join("\n\n");
  const several = quoted.length > 1;

  const request = dataRequest(quoted, opts.config, opts.restaurant, draft);
  if (request) {
    const price = several
      ? `${draft.soloPrecio ? "Los domicilios quedan así" : `Serían ${quoted.length} domicilios`} 🛵\n${list}\nTotal: ${cop(total)}`
      : draft.soloPrecio
        ? `Hasta ${deliveryLabel(quoted[0])} el domicilio vale ${cop(total)} 🛵`
        : `Serían ${cop(total)} hasta ${deliveryLabel(quoted[0])} 🛵`;
    return { text: join([opts.intro, opts.withPrice === false ? null : price, request, opts.coverageNote]) };
  }

  const price = several ? `Serían ${quoted.length} domicilios 🛵\n${list}\nTotal: ${cop(total)}` : `Serían ${cop(total)} 🛵`;
  const ask = several ? `¿Confirmo los ${quoted.length} servicios?` : "¿Confirmo el servicio?";
  return {
    text: join([opts.intro, readBackAll(quoted, !!opts.fromImage), `${price}\n${ask}\nSi algo no es, escríbeme el dato correcto.`, opts.coverageNote]),
    buttons: [{ id: CONFIRM_BUTTON_ID, title: several ? `Confirmar los ${quoted.length}` : "Confirmar servicio" }],
    summary: summaryOf(quoted),
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

type NearEdge = { delivery: DeliveryDraft; zone: string; meters: number; precio: number; km: number; fuente: RoadSource; desglose: FareSplit | null };

/**
 * Entregas fuera de las zonas de servicio pero cerca del borde (docs/
 * DIRECCIONES-Y-ZONAS.md, «Zonas de servicio en el bot»): el bot no decide
 * solo, le pregunta a la central si se hacen. Como en la consulta de
 * dirección, el borrador se conserva y el bot no contesta en ese chat hasta
 * que la central responde en el portal (`advisor.ts`). `note`: lo que se le
 * diga antes al restaurante (las entregas sin servicio).
 */
async function askCoverage(ctx: Context, draft: OrderDraft, near: NearEdge[], note: string) {
  draft.consultaAsesor = {
    entregas: near.map((n) => draft.entregas.indexOf(n.delivery)),
    desde: new Date().toISOString(),
    motivo: "cobertura",
    cobertura: near.map((n) => ({ indice: draft.entregas.indexOf(n.delivery), zona: n.zone, metros: n.meters, precio: n.precio, km: n.km, fuente: n.fuente, desglose: n.desglose })),
  };
  await updateConversation(ctx.conversation.id, {
    botPaused: true,
    escalationReason: coverageQueryReason(near.map((n) => ({ address: fullAddress(n.delivery), zone: n.zone, meters: n.meters }))),
    draft,
    failedAttempts: 0,
  });
  const text = [note, nearEdgeText(near.map((n) => deliveryLabel(n.delivery)))].filter(Boolean).join("\n\n");
  await say(ctx.conversation.id, ctx.message.phone, text, { replyTo: draft.mensajeOrigen });
}

/**
 * El pin de WhatsApp: coordenadas exactas, sin pagar geocodificación. Va a la
 * última entrega si todavía no está ubicada; si no, es una nueva. Después de
 * solo preguntar un precio, un pin suelto es un pedido aparte.
 */
function applyPin(draft: OrderDraft, pin: Pick<TurnPin, "lat" | "lng" | "label">): OrderDraft {
  const next: OrderDraft = draft.soloPrecio ? { ...draft, etapa: "recibiendo", entregas: [], mensajeOrigen: null, soloPrecio: false } : draft;
  const last = next.entregas[next.entregas.length - 1];
  const target = last && !last.ubicacionEntrega ? last : emptyDelivery();
  if (target !== last) next.entregas.push(target);
  const address = pin.label ?? target.direccionEntrega ?? pinAddress(pin);
  Object.assign(target, { direccionEntrega: address, direccionUbicada: address, ubicacionEntrega: { lat: pin.lat, lng: pin.lng }, cotizacion: null });
  return next;
}

/**
 * Un pin que llegó después de algún texto: el modelo lo leyó en su lugar
 * (`pinLine`) y la entrega de la que hablaba quedó con su dirección. Aquí
 * recibe las coordenadas. Si el modelo no la usó, va a la última entrega sin
 * ubicar, con la dirección que ya tenía escrita.
 */
function placePin(draft: OrderDraft, pin: Pick<TurnPin, "lat" | "lng" | "label">) {
  const address = normalizeName(pinAddress(pin));
  const unplaced = draft.entregas.filter((d) => !d.ubicacionEntrega);
  const target =
    unplaced.find((d) => d.direccionEntrega && (normalizeName(d.direccionEntrega).includes(address) || address.includes(normalizeName(d.direccionEntrega)))) ??
    unplaced[unplaced.length - 1];
  if (!target) {
    draft.entregas.push(emptyDelivery());
    return placePin(draft, pin);
  }
  target.direccionEntrega ??= pinAddress(pin);
  Object.assign(target, { direccionUbicada: target.direccionEntrega, ubicacionEntrega: { lat: pin.lat, lng: pin.lng }, cotizacion: null });
}

export async function handleRestaurant(ctx: Context) {
  const { conversation, message } = ctx;
  let { restaurant } = ctx;
  const config = await getBotConfig();
  // Se mide con la hora en que el restaurante envió el mensaje.
  const hours = await getServiceHours();
  const now = message.timestamp;
  const open = isOpen(now, hoursFor(restaurant, hours));

  const known = normalizeDraft(conversation.draft);
  if (restaurant) known.origenRestaurante = restaurant.name;
  let draft: OrderDraft = structuredClone(known);
  let confirms = false;
  let fromImage = false;
  let saidName: string | null = null;

  // Lo que trae el turno: el texto (con sus fotos), los pines y los botones
  // que mandó seguido (`bot/turns.ts`). Un mensaje suelto es un turno de uno.
  const text = message.kind === "text" ? message.text : "";
  const imageIds = message.kind === "text" ? (message.images ?? []) : [];
  const pins: TurnPin[] =
    message.kind === "location"
      ? [{ lat: message.lat, lng: message.lng, label: message.label, beforeText: true }]
      : message.kind === "text"
        ? (message.pins ?? [])
        : [];
  const buttons = message.kind === "button" ? [message.buttonId] : message.kind === "text" ? (message.buttons ?? []).map((b) => b.buttonId) : [];
  const reads = !!text.trim() || imageIds.length > 0;
  const pressedConfirm = buttons.includes(CONFIRM_BUTTON_ID);

  // Se le preguntó si es el restaurante de este número. Solo un «no» lo pasa a
  // la central; cualquier otra respuesta sigue con el pedido y no se repite.
  const answersIdentity = !!known.preguntaIdentidad;
  if (answersIdentity) {
    draft.preguntaIdentidad = false;
    if (buttons.includes(IDENTITY_NO_BUTTON_ID) || /^\s*no\b/i.test(text)) {
      // Fuera de horario no pasa a la central: el pedido igual no se recibe.
      if (!open) {
        await closedForOrders(ctx, hours.opensAt, now);
        return;
      }
      await escalateIdentity(ctx, draft, `Escribe desde el número de ${restaurant?.name ?? "un restaurante registrado"}, pero dice que no es ese restaurante.`);
      return;
    }
  }

  // 1. Lo que trae el mensaje.
  const pick = buttons.find((id) => id.startsWith(PICK_TRIP_PREFIX));
  if (pick) {
    await pickTrip({ conversation, phone: message.phone }, pick, known);
    return;
  }
  if (!reads && !pins.length) {
    // Confirmar pasada la hora límite: el pedido ya no se recibe (y el tick
    // pudo haberlo descartado), así que va el aviso de fuera de horario.
    if (pressedConfirm && !open) {
      await closedForOrders(ctx, hours.opensAt, now);
      return;
    }
    // Solo botones, o algo que todavía no se lee (un audio, un sticker).
    if (!buttons.length) {
      await say(conversation.id, message.phone, "Por ahora leo mensajes de texto y ubicaciones 🙏 ¿Me escribes la dirección de entrega?");
      return;
    }
    if (pressedConfirm && draft.entregas.some((d) => d.cotizacion)) confirms = true;
    else if (!(answersIdentity && buttons.includes(IDENTITY_YES_BUTTON_ID))) {
      if (pressedConfirm) await say(conversation.id, message.phone, "No tengo un pedido por confirmar 🤔 Envíame la dirección de entrega para cotizarte.");
      return;
    }
  }

  // Un pin antes del texto: el texto se lee ya con esa entrega («me das un
  // domi para esta dirección»).
  for (const pin of pins.filter((p) => p.beforeText)) draft = applyPin(draft, pin);
  // Contra esto se mide lo que cambió el texto.
  const before = structuredClone(draft);

  if (reads) {
    const images = (await Promise.all(imageIds.map(downloadImage))).filter((i): i is DownloadedImage => !!i);
    if (imageIds.length && !images.length && !text.trim() && !pins.length) {
      await say(conversation.id, message.phone, "No pude abrir la imagen 🙏 ¿Me escribes la dirección de entrega?");
      return;
    }
    const extraction = await interpretMessage(text, draft, images);
    // OpenAI falló: no es culpa del restaurante, así que no suma intentos, no
    // escala y el borrador queda como estaba. Solo se le pide reenviar.
    if (extraction.failed) {
      await say(conversation.id, message.phone, TECHNICAL_ERROR_MESSAGE);
      return;
    }
    if (extraction.confused) {
      // Fuera de horario no pasa a la central, salvo que tenga un pedido en
      // curso: lo ya confirmado se atiende igual («el domi no ha llegado»).
      if (!open && !(await openTrips(conversation.id)).length) {
        await closedForOrders(ctx, hours.opensAt, now);
        return;
      }
      await escalate(ctx, "El restaurante dio datos confusos o pidió hablar con una persona.");
      return;
    }

    // De qué pedido habla: el que citó o, si no citó, el que nombra por su
    // código («¿ya llegó el B-12?»).
    const quoted = (message.replyTo ? await tripFromQuote(conversation.id, message.replyTo) : null) ?? (await tripFromCodeInText(conversation.id, text));

    saidName = extraction.fields.nombreRestaurante ?? null;
    if (saidName && namedAsDestination(text, saidName)) saidName = null;

    // Consultas: no cambian el pedido en curso, solo se responden.
    if (extraction.query === "estado") {
      await answerStatus(conversation, message.phone, quoted);
      return;
    }
    const asksAddress = !pins.length && !extraction.fields.entregas.some((e) => e.direccionEntrega) && !before.entregas.some((e) => e.direccionEntrega);
    if (extraction.query === "cobertura" && asksAddress) {
      if (!open) {
        await closedForOrders(ctx, hours.opensAt, now);
        return;
      }
      await say(conversation.id, message.phone, "Envíame la dirección o la ubicación y te digo si llegamos y cuánto vale 🛵");
      return;
    }

    // ¿Habla de un pedido ya creado? Si citó uno de sus mensajes, de ese; si
    // no hay un pedido a medio armar y el mensaje no trae una dirección,
    // de sus pedidos abiertos (casos 9 y 12: «ya está listo»).
    const changed = changedDelivery(extraction.fields, before);
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
    if (!quoted && update && !newAddress && before.entregas.length === 0 && !pins.length && (await routeTripUpdate(updateCtx, update, known))) return;

    // ¿Solo pregunta el precio o pide el servicio? Preguntar si llegan a una
    // dirección también es solo cotizar.
    const priceOnly = extraction.intent === "cotizar" || extraction.query === "cobertura";
    // Ya se le dio solo un precio y ahora pregunta (o pide) a otra dirección:
    // es otra cotización, no un segundo domicilio. Se empieza de nuevo con lo
    // que trae este mensaje; la recogida se conserva.
    let fields = extraction.fields;
    if (before.soloPrecio && !extraction.confirms) {
      const fresh = fields.entregas.filter((e) => e.direccionEntrega && !before.entregas.some((k) => k.direccionEntrega === e.direccionEntrega));
      if (fresh.length) {
        draft = { ...draft, etapa: "recibiendo", entregas: [], mensajeOrigen: null };
        fields = { ...fields, entregas: fresh, quitar: [] };
      }
    }
    draft = mergeTripFields(draft, fields);
    draft.soloPrecio = priceOnly || (extraction.intent !== "pedir" && !!before.soloPrecio && draft.entregas.length > 0);
    if (restaurant) draft.origenRestaurante = restaurant.name;
    fromImage = images.length > 0;
    // El modelo repite el tiempo ya capturado: solo cuando cambia es un dato
    // nuevo, y se cuenta desde este mensaje.
    draft.entregas.forEach((d, i) => {
      if (d.listoEnMinutos != null && d.listoEnMinutos !== before.entregas[i]?.listoEnMinutos) d.listoDesde = message.timestamp.toISOString();
    });
    // Las que pidió quitar («solo es 1», «el de Pance ya no va»). Como el
    // pedido cambia, se le vuelve a mostrar antes de pedir la moto.
    draft = removeDeliveries(draft, fields.quitar ?? []).draft;
    // Vale solo si lo que acepta es el pedido completo que ya se le mostró
    // (paso 5): dar los datos o el tiempo no es confirmar.
    confirms = pressedConfirm || extraction.confirms;
  }

  // Lo que queda es pedir o cotizar: fuera de horario no se recibe. Las
  // consultas y los cambios de pedidos ya creados se respondieron arriba.
  if (!open) {
    await closedForOrders(ctx, hours.opensAt, now);
    return;
  }

  for (const pin of pins.filter((p) => !p.beforeText)) placePin(draft, pin);

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
  // confirma, aunque el restaurante ya hubiera confirmado lo anterior. Antes,
  // las zonas de servicio: fuera y lejos no se pide; cerca del borde lo
  // decide la central. Sin zonas cargadas no se restringe nada.
  const zones = deliveries.some((d) => !d.cotizacion) ? await listServiceZones() : [];
  const outOfRange: { delivery: DeliveryDraft; km: number }[] = [];
  const noService: DeliveryDraft[] = [];
  const nearEdge: NearEdge[] = [];
  let newQuote = false;
  for (const d of deliveries) {
    if (d.cotizacion) continue;
    const coverage = coverageAt(d.ubicacionEntrega, zones);
    if (coverage.kind === "fuera") {
      noService.push(d);
      continue;
    }
    const quote = await quoteDelivery(pickupLocation, d.ubicacionEntrega!, config, zones);
    if (quote.precio === null) {
      await escalate(ctx, "La tabla de tarifas por km está vacía: no hay con qué cotizar. Llénala en el portal (Tarifas).");
      return;
    }
    if (quote.outOfRange) {
      outOfRange.push({ delivery: d, km: quote.km! });
      continue;
    }
    if (coverage.kind === "cerca") {
      nearEdge.push({ delivery: d, zone: coverage.zone, meters: coverage.meters, precio: quote.precio, km: quote.km, fuente: quote.fuente, desglose: quote.desglose });
      continue;
    }
    d.cotizacion = { precio: quote.precio, km: quote.km, fuente: quote.fuente, desglose: quote.desglose };
    newQuote = true;
  }
  const dropped = [...noService, ...outOfRange.map((o) => o.delivery)];
  if (dropped.length) draft.entregas = draft.entregas.filter((d) => !dropped.includes(d));
  const coverageNote = [
    noServiceText(noService.map(deliveryLabel)),
    ...outOfRange.map((o) => `Hasta ${deliveryLabel(o.delivery)} no tenemos cobertura 🙏 (${o.km} km, llegamos hasta ${config.maxKm} km).`),
  ]
    .filter(Boolean)
    .join("\n");
  if (nearEdge.length) {
    await askCoverage(ctx, draft, nearEdge, coverageNote);
    return;
  }
  const quoted = draft.entregas.filter((d) => d.cotizacion);

  if (!quoted.length) {
    await save(ctx, null);
    await say(conversation.id, message.phone, coverageNote, { replyTo });
    return;
  }

  // 5. Se pide la moto solo cuando aceptó el pedido completo tal como se le
  // mostró. Mientras tanto: el precio con lo que falta, o el pedido completo
  // con el botón. Confirmar también acepta los datos dudosos (❓).
  const accepted = confirms && draft.resumenMostrado === summaryOf(quoted);
  if (!accepted) {
    const priceChanged = newQuote || dropped.length > 0;
    // Solo había preguntado el precio y no decidió mandarlo («gracias», «ok»):
    // no se le insiste ni cuenta como intento. El precio queda guardado por si
    // después dice «dale» o manda los datos.
    if (!priceChanged && draft.soloPrecio) {
      await save(ctx, draft);
      return;
    }
    const reply = quoteMessage(draft, { config, restaurant, fromImage, coverageNote, withPrice: priceChanged });
    draft.etapa = "cotizado";
    draft.resumenMostrado = reply.summary ?? null;
    // Un precio nuevo siempre se muestra, sin contar intentos.
    const reason = reply.summary ? "sin confirmar el servicio" : "sin los datos que faltan";
    if (priceChanged) await save(ctx, draft);
    else if (!(await countAttempt(ctx, draft, progressed, `${MAX_CLARIFICATION_ATTEMPTS} mensajes seguidos ${reason}.`))) return;
    const text = !priceChanged && !reply.summary && progressed ? `Anotado ✅ ${reply.text}` : reply.text;
    await say(conversation.id, message.phone, text, { replyTo, buttons: reply.buttons });
    return;
  }

  // 6. Aceptado: un viaje por entrega, y cada uno se despacha.
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
