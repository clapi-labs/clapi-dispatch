import type { DeliveryDraft, Interpretation, OrderDraft, TripUpdate } from "@dispatch/shared";

import { say } from "@/bot/messaging";
import { notifyTripUpdated } from "@/bot/notify";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import { getTrip, openTrips, updateTrip, type Trip } from "@/db/queries/trips";

/**
 * Mensajes sobre un pedido que ya se creó: «ya está listo», «se demora 5 más»,
 * «el cliente paga con 50». No abren un pedido nuevo (casos 9 y 12 de
 * docs/CONVERSACIONES-REALES.md): cambian el que corresponde y se avisa al
 * motorizado si ya tiene uno.
 *
 * De qué pedido habla se sabe, en este orden: por el mensaje que citó; si
 * no citó y tiene uno solo abierto, ese; si tiene varios, se le pregunta.
 */

export const PICK_TRIP_PREFIX = "pedido:";

type Context = { conversation: Conversation; phone: string };

/** Lo que el mensaje cambia frente a lo que ya se sabía. `null` si nada. */
export function tripUpdateFrom(fields: Interpretation["entregas"][number], known: DeliveryDraft, at: Date): TripUpdate | null {
  const update: TripUpdate = { desde: at.toISOString() };
  if (fields.listoEnMinutos != null && fields.listoEnMinutos !== known.listoEnMinutos) update.listoEnMinutos = fields.listoEnMinutos;
  if (fields.notas) update.notas = fields.notas;
  if (fields.telefonoCliente && fields.telefonoCliente !== known.telefonoCliente) update.telefonoCliente = fields.telefonoCliente;
  if (fields.nombreCliente && fields.nombreCliente !== known.nombreCliente) update.nombreCliente = fields.nombreCliente;
  if (fields.valorACobrar != null && fields.valorACobrar !== known.valorACobrar) update.valorACobrar = fields.valorACobrar;
  if (fields.metodoPago && fields.metodoPago !== known.metodoPago) update.metodoPago = fields.metodoPago;
  return Object.keys(update).length > 1 ? update : null;
}

/** Cómo se le cuenta el cambio a cada uno. */
function describe(update: TripUpdate) {
  const parts: string[] = [];
  if (update.listoEnMinutos != null) parts.push(update.listoEnMinutos === 0 ? "la comida ya está lista" : `la comida está lista en ${update.listoEnMinutos} min`);
  if (update.metodoPago) parts.push(update.metodoPago === "efectivo" ? "se cobra en efectivo" : "ya está pagado, no se cobra");
  if (update.valorACobrar != null) parts.push(`valor a cobrar ${new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(update.valorACobrar)}`);
  if (update.telefonoCliente || update.nombreCliente) parts.push("datos del cliente actualizados");
  if (update.notas) parts.push(`nota: ${update.notas}`);
  return parts.join(" · ");
}

export async function applyTripUpdate(ctx: Context, trip: Trip, update: TripUpdate) {
  if (trip.status === "delivered" || trip.status === "cancelled") {
    await say(ctx.conversation.id, ctx.phone, `El pedido ${trip.code} ya estaba ${trip.status === "delivered" ? "entregado" : "cancelado"} ✅`, {
      replyTo: trip.sourceWaMessageId,
      tripId: trip.id,
    });
    return;
  }

  const patch: Partial<Trip> = {};
  if (update.listoEnMinutos != null) patch.readyAt = new Date(Date.parse(update.desde) + update.listoEnMinutos * 60_000);
  if (update.notas) patch.notes = [trip.notes, update.notas].filter(Boolean).join(" · ");
  if (update.telefonoCliente) patch.customerPhone = update.telefonoCliente;
  if (update.nombreCliente) patch.customerName = update.nombreCliente;
  if (update.valorACobrar != null) patch.valueToCollect = update.valorACobrar;
  if (update.metodoPago) {
    patch.paymentMethod = update.metodoPago;
    patch.requiresCashReturn = update.metodoPago === "efectivo";
  }
  await updateTrip(trip.id, patch);

  const change = describe(update);
  await say(ctx.conversation.id, ctx.phone, `Anotado ✅ ${trip.code}: ${change}`, { replyTo: trip.sourceWaMessageId, tripId: trip.id });
  await notifyTripUpdated(trip.id, change);
}

/**
 * Un cambio sin cita: al único pedido abierto, o se pregunta a cuál. Devuelve
 * `false` si no hay pedidos abiertos (el mensaje sigue como uno nuevo).
 */
export async function routeTripUpdate(ctx: Context, update: TripUpdate, draft: OrderDraft): Promise<boolean> {
  const trips = await openTrips(ctx.conversation.id);
  if (trips.length === 0) return false;
  if (trips.length === 1) {
    await applyTripUpdate(ctx, trips[0], update);
    return true;
  }

  // Varios abiertos: se guarda el cambio y se pregunta. Hasta 3 van como
  // botones (el tope de WhatsApp); con más, se le pide citar el pedido.
  await updateConversation(ctx.conversation.id, { draft: { ...draft, actualizacionPendiente: update } });
  const list = trips.map((t) => `• ${t.code}: ${t.deliveryAddress}`).join("\n");
  if (trips.length <= 3) {
    await say(ctx.conversation.id, ctx.phone, `¿De cuál pedido hablas? 🤔\n\n${list}`, {
      buttons: trips.map((t) => ({ id: `${PICK_TRIP_PREFIX}${t.id}`, title: t.code })),
    });
  } else {
    await say(ctx.conversation.id, ctx.phone, `¿De cuál pedido hablas? 🤔 Respóndeme citando el mensaje del pedido.\n\n${list}`);
  }
  return true;
}

/** Tocó el botón de uno de los pedidos: se aplica el cambio que esperaba. */
export async function pickTrip(ctx: Context, buttonId: string, draft: OrderDraft) {
  const update = draft.actualizacionPendiente;
  const trip = await getTrip(Number(buttonId.slice(PICK_TRIP_PREFIX.length)));
  await updateConversation(ctx.conversation.id, { draft: { ...draft, actualizacionPendiente: null } });
  if (!update || !trip || trip.conversationId !== ctx.conversation.id) {
    await say(ctx.conversation.id, ctx.phone, "No tengo ningún cambio pendiente 🤔 ¿Me lo repites?");
    return;
  }
  await applyTripUpdate(ctx, trip, update);
}
