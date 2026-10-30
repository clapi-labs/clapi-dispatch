/**
 * Modo demo: datos de ejemplo para ver el portal sin base de datos.
 *
 * Se enciende con `NEXT_PUBLIC_DEMO=1` (por ejemplo en apps/portal/.env.local)
 * y solo existe en el navegador: reemplaza `fetch` para las rutas `/api/*` y
 * responde desde memoria. Las acciones (intervenir, enviar, entregar, guardar
 * tarifas) cambian esos datos hasta recargar la página. Sin la variable, este
 * archivo no hace nada.
 *
 * A los 20 s de abrir, un restaurante pide hablar con una persona: sirve para
 * ver llegar la burbuja amarilla y oír la alerta.
 */
import { needsHelp, TAKEOVER_REASON } from "@/lib/chat";
import type {
  ChatMessage,
  ConversationSummary,
  Courier,
  CourierProfile,
  FareMatrix,
  FareRange,
  Settlement,
  SettlementRow,
  Trip,
} from "@/lib/types";

export const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

const T0 = Date.now();
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString();

// ---------------------------------------------------------------------------
// Flota
// ---------------------------------------------------------------------------

const couriers: Courier[] = [
  { id: 1, name: "Juan Rodríguez", phone: "573001112233", status: "busy", lat: 3.4372, lng: -76.5422, locationUpdatedAt: ago(1), deliveriesThisShift: 6, lastAssignedAt: ago(18), active: true, createdAt: ago(600) },
  { id: 2, name: "Carlos Mejía", phone: "573104445566", status: "available", lat: 3.4583, lng: -76.5322, locationUpdatedAt: ago(3), deliveriesThisShift: 4, lastAssignedAt: ago(95), active: true, createdAt: ago(600) },
  { id: 3, name: "Andrés Gómez", phone: "573207778899", status: "available", lat: 3.3609, lng: -76.5352, locationUpdatedAt: ago(26), deliveriesThisShift: 5, lastAssignedAt: ago(60), active: true, createdAt: ago(600) },
  { id: 4, name: "Mateo Vargas", phone: "573156667788", status: "busy", lat: 3.4764, lng: -76.5281, locationUpdatedAt: ago(2), deliveriesThisShift: 3, lastAssignedAt: ago(31), active: true, createdAt: ago(600) },
  { id: 5, name: "Luis Torres", phone: "573012223344", status: "paused", lat: null, lng: null, locationUpdatedAt: null, deliveriesThisShift: 2, lastAssignedAt: ago(180), active: true, createdAt: ago(600) },
  { id: 6, name: "Diego Ramírez", phone: "573189990011", status: "offline", lat: 3.4224, lng: -76.5405, locationUpdatedAt: ago(240), deliveriesThisShift: 0, lastAssignedAt: null, active: true, createdAt: ago(600) },
];

const profiles = new Map<number, CourierProfile>([
  [1, { vehiclePlate: "XYZ12F", vehicleType: "Moto", documentId: "1.144.123.456", emergencyContactName: "Marta Rodríguez", emergencyContactPhone: "3005551122" }],
]);

// ---------------------------------------------------------------------------
// Viajes
// ---------------------------------------------------------------------------

let nextTripId = 200;
function trip(partial: Partial<Trip> & Pick<Trip, "originRestaurantName" | "deliveryAddress" | "status">): Trip {
  const id = nextTripId++;
  return {
    id,
    code: `DSP-${String(id).padStart(4, "0")}`,
    pickupAddress: null,
    customerPhone: "3157894561",
    valueToCollect: 45_000,
    paymentMethod: "efectivo",
    requiresCashReturn: true,
    deliveryFee: 6_000,
    pickupZone: null,
    deliveryZone: null,
    createdAt: ago(10),
    updatedAt: ago(5),
    courierName: null,
    courierId: null,
    courierPhone: null,
    assignedAt: null,
    deliveredAt: null,
    ...partial,
  };
}

const courierOf = (id: number) => {
  const c = couriers.find((x) => x.id === id)!;
  return { courierId: c.id, courierName: c.name, courierPhone: c.phone };
};

const trips: Trip[] = [
  // Por asignar: uno recién llegado y uno que ya pasa de 2 min (urgente).
  trip({ status: "pending", originRestaurantName: "Pizzería Napoli", deliveryAddress: "Cra 66 #10-45, El Limonar", pickupZone: "San Fernando", deliveryZone: "El Limonar", createdAt: ago(0.6), valueToCollect: 52_000 }),
  trip({ status: "pending", originRestaurantName: "Sushi Cali", deliveryAddress: "Calle 5 #38-20, Apto 502, Torre B", paymentMethod: "transferencia", requiresCashReturn: false, createdAt: ago(3.5), valueToCollect: 88_000, deliveryFee: 7_000 }),
  // En ruta: uno normal, uno que ya va largo (amarillo) y uno muy largo (rojo).
  trip({ status: "en_route", originRestaurantName: "Donde Lucho", deliveryAddress: "Calle 18 #122-35, Valle del Lili", pickupZone: "Ciudad Jardín", deliveryZone: "Valle del Lili", createdAt: ago(20), assignedAt: ago(9), ...courierOf(1) }),
  trip({ status: "en_route", originRestaurantName: "La Brasa Roja", deliveryAddress: "Av. 6N #28-10, Granada", paymentMethod: "transferencia", requiresCashReturn: false, createdAt: ago(40), assignedAt: ago(28), valueToCollect: 64_500, deliveryFee: 8_000, ...courierOf(4) }),
  // Entregados hoy.
  trip({ status: "delivered", originRestaurantName: "Donde Lucho", deliveryAddress: "Cra 100 #11-60, Ciudad Jardín", createdAt: ago(130), assignedAt: ago(125), deliveredAt: ago(104), ...courierOf(1) }),
  trip({ status: "delivered", originRestaurantName: "Pizzería Napoli", deliveryAddress: "Calle 9 #43-12, San Fernando", paymentMethod: "transferencia", requiresCashReturn: false, createdAt: ago(160), assignedAt: ago(155), deliveredAt: ago(131), valueToCollect: 39_000, ...courierOf(2) }),
  trip({ status: "delivered", originRestaurantName: "Sushi Cali", deliveryAddress: "Cra 4 #12-41, Centro", createdAt: ago(200), assignedAt: ago(196), deliveredAt: ago(170), valueToCollect: 72_000, deliveryFee: 7_000, ...courierOf(3) }),
  trip({ status: "delivered", originRestaurantName: "La Brasa Roja", deliveryAddress: "Calle 70N #2A-30, Chipichape", createdAt: ago(250), assignedAt: ago(245), deliveredAt: ago(220), valueToCollect: 56_000, deliveryFee: 8_000, ...courierOf(4) }),
];

// ---------------------------------------------------------------------------
// Conversaciones
// ---------------------------------------------------------------------------

type DemoConversation = Omit<ConversationSummary, "lastText" | "lastRole">;

const conversations: DemoConversation[] = [
  // El bot escaló: pide ayuda (fijado, amarillo).
  { id: 1, phone: "573164441234", displayName: "Donde Lucho", kind: "restaurant", courierName: null, botPaused: true, escalationReason: "El restaurante dio datos confusos o pidió hablar con una persona.", draft: null, lastMessageAt: ago(2) },
  // Un motorizado escalado: también pide ayuda.
  { id: 2, phone: "573001112233", displayName: "Juancho", kind: "courier", courierName: "Juan Rodríguez", botPaused: true, escalationReason: "3 mensajes seguidos sin datos nuevos del pedido.", draft: null, lastMessageAt: ago(6) },
  // La central ya respondió: fijado, "Tú atiendes", sin amarillo.
  { id: 3, phone: "573175556677", displayName: "La Brasa Roja", kind: "restaurant", courierName: null, botPaused: true, escalationReason: TAKEOVER_REASON, draft: null, lastMessageAt: ago(12) },
  // El bot está armando un pedido.
  { id: 4, phone: "573128889900", displayName: "Pizzería Napoli", kind: "restaurant", courierName: null, botPaused: false, escalationReason: null, draft: { origenRestaurante: "Pizzería Napoli", direccionEntrega: "Cra 66 #10-45", telefonoCliente: null, valorACobrar: 52_000, metodoPago: null }, lastMessageAt: ago(15) },
  { id: 5, phone: "573104445566", displayName: "Carlos M", kind: "courier", courierName: "Carlos Mejía", botPaused: false, escalationReason: null, draft: null, lastMessageAt: ago(95) },
  { id: 6, phone: "573159993311", displayName: "Sushi Cali", kind: "restaurant", courierName: null, botPaused: false, escalationReason: null, draft: null, lastMessageAt: ago(60 * 26) },
];

let nextMessageId = 1000;
const msg = (role: ChatMessage["role"], text: string, minutesAgo: number): ChatMessage => ({ id: nextMessageId++, role, text, createdAt: ago(minutesAgo) });

const threads = new Map<number, ChatMessage[]>([
  [
    1,
    [
      // Ayer: para ver el separador de día.
      msg("restaurant", "Buenas noches, ¿todavía tienen motos disponibles?", 60 * 22),
      msg("bot", "¡Hola! Sí, claro. Mándame el pedido: dirección de entrega, teléfono del cliente, valor y forma de pago.", 60 * 22 - 1),
      msg("restaurant", "Listo, ya no, gracias", 60 * 21),
      // Hoy.
      msg("restaurant", "Hola, necesito un domicilio para Valle del Lili", 9),
      msg("bot", "Con gusto. ¿Cuál es la dirección exacta y el teléfono del cliente?", 8),
      msg("restaurant", "Calle 18 #122-35 pero el cliente dice que mejor se lo lleven a la oficina, no sé la dirección todavía, y si se puede que lleven datáfono porque no tiene efectivo, o si no que pague por transferencia pero a nombre de otra persona", 4),
      msg("bot", "Te paso con una persona de la central para ayudarte con esto. Ya te escriben.", 3),
      msg("restaurant", "ok", 2),
    ],
  ],
  [
    2,
    [
      msg("restaurant", "Ya recogí en Donde Lucho", 14),
      msg("bot", "¡Perfecto! Entrega en Calle 18 #122-35, Valle del Lili. Cobra $45.000 en efectivo.", 14),
      msg("restaurant", "El cliente no contesta", 9),
      msg("bot", "¿Me confirmas en qué parte del pedido necesitas ayuda?", 9),
      msg("restaurant", "No contesta y la portería no me deja subir", 7),
      msg("bot", "Te paso con la central para que te ayuden.", 6),
    ],
  ],
  [
    3,
    [
      msg("restaurant", "Necesito cambiar el valor del pedido DSP-0203", 20),
      msg("bot", "Te paso con una persona de la central.", 19),
      msg("agent", "Hola, ya lo cambio. ¿Cuál es el valor nuevo?", 15),
      msg("restaurant", "$64.500", 14),
      msg("agent", "Listo, quedó en $64.500. El motorizado ya va en camino 🛵", 12),
    ],
  ],
  [
    4,
    [
      msg("restaurant", "Domicilio para Cra 66 #10-45, cobrar 52 mil", 16),
      msg("bot", "¡Listo! Ya tengo la dirección y el valor. ¿Cuál es el teléfono del cliente y cómo va a pagar?", 15),
    ],
  ],
  [
    5,
    [
      msg("restaurant", "Ya entregué en San Fernando", 96),
      msg("bot", "¡Gracias, Carlos! Quedas libre para el siguiente viaje.", 95),
    ],
  ],
  [
    6,
    [
      msg("restaurant", "¿A qué hora cierran hoy?", 60 * 27),
      msg("bot", "Atendemos hasta las 11 p. m. todos los días.", 60 * 26),
    ],
  ],
]);

function summaries(): ConversationSummary[] {
  return conversations
    .map((c) => {
      const thread = threads.get(c.id) ?? [];
      const last = thread[thread.length - 1];
      return { ...c, lastText: last?.text ?? null, lastRole: last?.role ?? null };
    })
    .sort((a, b) => {
      const rank = (c: ConversationSummary) => (needsHelp(c) ? 2 : c.botPaused ? 1 : 0);
      return rank(b) - rank(a) || b.lastMessageAt.localeCompare(a.lastMessageAt);
    });
}

function pushMessage(conversationId: number, role: ChatMessage["role"], text: string) {
  const message: ChatMessage = { id: nextMessageId++, role, text, createdAt: new Date().toISOString() };
  threads.set(conversationId, [...(threads.get(conversationId) ?? []), message]);
  const c = conversations.find((x) => x.id === conversationId);
  if (c) c.lastMessageAt = message.createdAt;
}

// ---------------------------------------------------------------------------
// Tarifas
// ---------------------------------------------------------------------------

const zoneNames = ["San Fernando", "Granada", "Ciudad Jardín", "Valle del Lili", "El Limonar"];
let fareMatrix: FareMatrix = {
  zones: zoneNames.map((name, i) => ({ id: i + 1, name, keywords: [name.toLowerCase()], sortOrder: i })),
  fares: zoneNames.flatMap((_, o) => zoneNames.map((__, d) => ({ originZoneId: o + 1, destinationZoneId: d + 1, price: o === d ? 5_000 : 6_000 + Math.abs(o - d) * 1_000 }))),
  defaultFare: 7_000,
};
let fareRanges: FareRange[] = [
  { upToKm: 2, price: 5_000 },
  { upToKm: 4, price: 6_000 },
  { upToKm: 7, price: 8_000 },
  { upToKm: null, price: 11_000 },
];

// ---------------------------------------------------------------------------
// Finanzas
// ---------------------------------------------------------------------------

function settlement(): Settlement {
  const delivered = trips.filter((t) => t.status === "delivered");
  const byMethod = { cash: { orders: 0, amount: 0 }, transfer: { orders: 0, amount: 0 } };
  const byCourier = new Map<string, SettlementRow>();
  let netEarnings = 0;
  for (const t of delivered) {
    netEarnings += t.deliveryFee;
    const m = t.paymentMethod === "efectivo" ? byMethod.cash : byMethod.transfer;
    m.orders += 1;
    m.amount += t.valueToCollect;
    const name = t.courierName ?? "—";
    const row = byCourier.get(name) ?? { courierId: t.courierId ?? 0, courierName: name, deliveredCount: 0, netEarnings: 0, cashToDeliver: 0 };
    row.deliveredCount += 1;
    row.netEarnings += t.deliveryFee;
    if (t.paymentMethod === "efectivo") row.cashToDeliver += t.valueToCollect;
    byCourier.set(name, row);
  }
  return {
    netEarnings,
    deliveredCount: delivered.length,
    averageFee: delivered.length ? Math.round(netEarnings / delivered.length) : 0,
    byMethod,
    couriers: [...byCourier.values()].sort((a, b) => b.netEarnings - a.netEarnings),
  };
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function handle(method: string, path: string, body: string | null): Promise<Response | null> {
  const data = body ? JSON.parse(body) : {};
  let m: RegExpMatchArray | null;

  if (path === "/api/trips" && method === "GET") return json(trips);
  if (path === "/api/dispatch/auto-assign") return json({ assigned: 0 });
  if ((m = path.match(/^\/api\/trips\/(\d+)\/deliver$/))) {
    const t = trips.find((x) => x.id === Number(m![1]));
    if (t && t.status === "en_route") {
      t.status = "delivered";
      t.deliveredAt = t.updatedAt = new Date().toISOString();
      const c = couriers.find((x) => x.id === t.courierId);
      if (c) c.status = "available";
    }
    return json({ ok: true });
  }

  if (path === "/api/conversations/needs-help") return json({ count: summaries().filter(needsHelp).length });
  if (path === "/api/conversations") return json(summaries());
  if ((m = path.match(/^\/api\/conversations\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === "GET") return json(threads.get(id) ?? []);
    const c = conversations.find((x) => x.id === id);
    if (!c) return json({ error: "No existe" }, 404);
    if (data.action === "pause") Object.assign(c, { botPaused: true, escalationReason: TAKEOVER_REASON, draft: null });
    if (data.action === "resume") Object.assign(c, { botPaused: false, escalationReason: null, draft: null });
    if (data.action === "send" && typeof data.text === "string") {
      c.botPaused = true;
      c.escalationReason ??= TAKEOVER_REASON;
      pushMessage(id, "agent", data.text.trim());
    }
    return json({ ok: true });
  }

  if (path === "/api/couriers" && method === "GET") return json(couriers.filter((c) => c.active));
  if (path === "/api/couriers" && method === "POST") {
    const c: Courier = { id: couriers.length + 100, name: data.name, phone: data.phone, status: "available", lat: null, lng: null, locationUpdatedAt: null, deliveriesThisShift: 0, lastAssignedAt: null, active: true, createdAt: new Date().toISOString() };
    couriers.unshift(c);
    return json(c, 201);
  }
  if ((m = path.match(/^\/api\/couriers\/(\d+)\/profile$/))) {
    const id = Number(m[1]);
    if (method === "PUT") profiles.set(id, data);
    return json(profiles.get(id) ?? { vehiclePlate: null, vehicleType: null, documentId: null, emergencyContactName: null, emergencyContactPhone: null });
  }
  if ((m = path.match(/^\/api\/couriers\/(\d+)$/))) {
    const c = couriers.find((x) => x.id === Number(m![1]));
    if (c && typeof data.status === "string") c.status = data.status;
    if (c && data.active === false) c.active = false;
    return json(c ?? {});
  }

  if (path === "/api/settlement") return json(settlement());

  if (path === "/api/fares/ranges") {
    if (method === "PUT") fareRanges = data.ranges;
    return json(method === "PUT" ? { ok: true } : fareRanges);
  }
  if (path === "/api/fares") {
    if (method === "PUT") fareMatrix = { ...fareMatrix, fares: data.fares, defaultFare: data.defaultFare };
    return json(method === "PUT" ? { ok: true } : fareMatrix);
  }

  return null;
}

/** Reemplaza `fetch` en el navegador para las rutas `/api/*`. Se llama una sola vez. */
let installed = false;
export function installDemo() {
  if (!DEMO || installed || typeof window === "undefined") return;
  installed = true;
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const body = typeof init?.body === "string" ? init.body : null;
      const response = await handle(method, url.pathname, body);
      if (response) return response;
    }
    return realFetch(input, init);
  };

  // A los 20 s, Pizzería Napoli pide una persona: llega la burbuja y suena la alerta.
  setTimeout(() => {
    const c = conversations.find((x) => x.id === 4);
    if (!c || c.botPaused) return;
    pushMessage(4, "restaurant", "Mejor páseme con alguien, el cliente quiere pagar la mitad en efectivo y la mitad por Nequi");
    pushMessage(4, "bot", "Te paso con una persona de la central. Ya te escriben.");
    Object.assign(c, { botPaused: true, escalationReason: "El restaurante dio datos confusos o pidió hablar con una persona.", draft: null });
  }, 20_000);
}
