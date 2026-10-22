import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { ExtractedTripFields, PaymentMethod } from "../domain/extraction";
import type { OfferOutcome } from "../domain/dispatch/types";

/**
 * Esquema de CLAPI Dispatch.
 *
 * Qué se trajo de CLAPI (sin cambios de fondo): `conversations`, `messages`,
 * `processed_messages` — el canal de WhatsApp es el mismo problema sin
 * importar qué hay del otro lado del chat.
 *
 * Qué se fue: todo el catálogo (`categories`, `products`, `options`,
 * `promotions`) y el carrito (`order_items`). No hay nada que vender, solo
 * viajes que despachar.
 *
 * Qué es nuevo: `restaurants` (quién pide), `trips` (qué se pide),
 * `couriers` con ubicación en vivo, y `dispatch_offers` — el historial de
 * cada oferta de los 15 s, que `deliveries` en CLAPI no necesitaba porque ahí
 * la asignación era manual y de un solo intento.
 */

// ---------------------------------------------------------------------------
// Canal de WhatsApp (igual que CLAPI)
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    /** El número del restaurante que le escribe a la agencia. */
    phone: text("phone").notNull().unique(),
    displayName: text("display_name"),
    botPaused: boolean("bot_paused").notNull().default(false),
    /** Por qué el bot se apartó y le pasó la conversación a una persona. */
    escalationReason: text("escalation_reason"),
    /**
     * El pedido a medio armar. Es la memoria entre mensajes: el restaurante
     * puede mandar la dirección en uno y el teléfono en el siguiente, y el
     * bot no puede olvidar el primero al leer el segundo. Se vacía al crear
     * el viaje o al escalar.
     */
    draft: jsonb("draft").$type<ExtractedTripFields>(),
    /** Cuántas veces se repreguntó por el pedido en curso. */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_last_message_idx").on(t.lastMessageAt)],
);

export type MessageRole = "restaurant" | "bot" | "agent";

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<MessageRole>(),
    text: text("text").notNull().default(""),
    waMessageId: text("wa_message_id"),
    /** Lo que extrajo el modelo de este mensaje, antes de validar que esté
     *  completo. Queda guardado para poder auditar por qué un viaje pidió
     *  una repregunta. */
    extraction: jsonb("extraction").$type<ExtractedTripFields>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.id)],
);

export const processedMessages = pgTable("processed_messages", {
  waMessageId: text("wa_message_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Restaurantes — registro liviano, no multi-tenant con login
// ---------------------------------------------------------------------------

/**
 * No hay aislamiento de datos por restaurante (eso sería multi-tenant de
 * verdad, con su propio login — fuera de alcance del MVP). Esta tabla existe
 * para no repetir la dirección de recogida en cada mensaje y para que las
 * métricas ("¿qué restaurante pide más?") no dependan de texto libre
 * reescrito cada vez distinto.
 */
export const restaurants = pgTable(
  "restaurants",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    /** El wa_id de quien escribe a la agencia. Único: cada número de
     *  restaurante es una sola fila, aunque escriba "donde siempre" cada vez
     *  con un nombre ligeramente distinto. */
    phone: text("phone").notNull().unique(),
    /** La dirección de recogida que más se repite para este restaurante.
     *  Se completa con la primera entrega confirmada y de ahí en adelante se
     *  usa como respaldo si el mensaje no la trae. */
    knownPickupAddress: text("known_pickup_address"),
    knownPickupLocation: jsonb("known_pickup_location").$type<{ lat: number; lng: number }>(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("restaurants_phone_idx").on(t.phone)],
);

// ---------------------------------------------------------------------------
// Viajes
// ---------------------------------------------------------------------------

export type TripStatus = "pending" | "assigned" | "en_route" | "delivered" | "cancelled";

export const trips = pgTable(
  "trips",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull().unique(),

    restaurantId: integer("restaurant_id").references(() => restaurants.id, { onDelete: "set null" }),
    conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),

    status: text("status").notNull().$type<TripStatus>().default("pending"),

    /** Lo que el restaurante escribió como su propio nombre — no una
     *  dirección. La dirección de recogida (`pickupAddress`) puede quedar
     *  sin resolver al crear el viaje: el extractor del mensaje libre no
     *  siempre la trae, y se completa después contra `restaurants` o a mano
     *  desde el portal. Separarlas evita que "Donde Lucho" termine guardado
     *  en una columna que se llama dirección. */
    originRestaurantName: text("origin_restaurant_name").notNull(),
    pickupAddress: text("pickup_address"),
    pickupLocation: jsonb("pickup_location").$type<{ lat: number; lng: number }>(),
    deliveryAddress: text("delivery_address").notNull(),
    deliveryLocation: jsonb("delivery_location").$type<{ lat: number; lng: number }>(),

    customerPhone: text("customer_phone").notNull(),
    valueToCollect: integer("value_to_collect").notNull(),
    /** Lo que cobra la agencia por el domicilio: su ganancia. Sale de la
     *  tabla de tarifas (zona de recogida × zona de entrega) y se congela al
     *  crear el viaje — cambiar la tarifa mañana no reescribe el arqueo de hoy. */
    deliveryFee: integer("delivery_fee").notNull().default(0),
    pickupZone: text("pickup_zone"),
    deliveryZone: text("delivery_zone"),
    paymentMethod: text("payment_method").notNull().$type<PaymentMethod>(),
    /** Derivado de `paymentMethod`, pero congelado: si la regla de negocio
     *  cambia mañana, un viaje de hoy no cambia de opinión retroactivamente. */
    requiresCashReturn: boolean("requires_cash_return").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trips_status_idx").on(t.status),
    index("trips_restaurant_idx").on(t.restaurantId),
  ],
);

// ---------------------------------------------------------------------------
// Flota
// ---------------------------------------------------------------------------

export type CourierStatus = "available" | "busy" | "paused" | "offline";

export const couriers = pgTable("couriers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** wa_id del motorizado — por ahí le llega la ficha del viaje. */
  phone: text("phone").notNull(),
  status: text("status").notNull().$type<CourierStatus>().default("offline"),

  /** Última posición conocida. Columnas simples, no PostGIS/Redis geo: a la
   *  escala de un MVP (decenas de motos) un `real` por eje y un filtro
   *  Haversine en memoria sobran. Se migra a Redis GEO solo si la flota
   *  crece lo suficiente para que importe — ver docs/PLAN_REFACTOR.md. */
  lat: real("lat"),
  lng: real("lng"),
  locationUpdatedAt: timestamp("location_updated_at", { withTimezone: true }),

  /** Se reinicia al cerrar turno (`SettlementView`); es el insumo del
   *  factor de equidad. */
  deliveriesThisShift: integer("deliveries_this_shift").notNull().default(0),
  /** El turno en la cola: se asigna primero al que hace más tiempo no
   *  recibe un viaje (round-robin). Nulo = nunca ha recibido, va primero. */
  lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
  shiftStartedAt: timestamp("shift_started_at", { withTimezone: true }),

  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** La ficha del motorizado: su vehículo y sus datos personales. Tabla aparte
 *  y no columnas en `couriers` a propósito: esa fila la leen el bot y la cola
 *  en cada mensaje con `select()`, así que una columna nueva sin aplicar en
 *  la base tumbaría el bot. Esto solo se consulta al abrir "Ver más" en
 *  Flota. */
export const courierProfiles = pgTable("courier_profiles", {
  courierId: integer("courier_id")
    .primaryKey()
    .references(() => couriers.id, { onDelete: "cascade" }),
  vehiclePlate: text("vehicle_plate"),
  vehicleType: text("vehicle_type"),
  documentId: text("document_id"),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: text("emergency_contact_phone"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** La asignación vigente de un viaje — una fila por viaje, igual que
 *  `deliveries` en CLAPI y por la misma razón: reasignar sustituye, no
 *  acumula. */
export const assignments = pgTable(
  "assignments",
  {
    id: serial("id").primaryKey(),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    courierId: integer("courier_id").references(() => couriers.id, { onDelete: "set null" }),
    courierName: text("courier_name").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("assignments_trip_idx").on(t.tripId)],
);

/**
 * El historial de ofertas de los 15 s — lo que `deliveries` en CLAPI no
 * necesitaba tener porque ahí un cajero elegía una vez y ya. Una fila por
 * intento, no por viaje: un viaje que ofertó a tres motos antes de que la
 * tercera aceptara deja tres filas.
 *
 * `scoreBreakdown` guarda los factores y el score de ese intento — no para
 * la operación del día a día, sino para poder explicar y ajustar el
 * algoritmo después ("¿por qué le ofreció a Pedro y no a Luis a las 7pm?").
 */
export const dispatchOffers = pgTable(
  "dispatch_offers",
  {
    id: serial("id").primaryKey(),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    courierId: integer("courier_id")
      .notNull()
      .references(() => couriers.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    scoreBreakdown: jsonb("score_breakdown").$type<{
      score: number;
      factors: { time: number; route: number; equity: number };
      etaMinutes: number;
      etaSource: "cache" | "api" | "estimated";
    }>(),
    offeredAt: timestamp("offered_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    outcome: text("outcome").$type<OfferOutcome>(),
  },
  (t) => [
    index("dispatch_offers_trip_idx").on(t.tripId),
    // Para el barrido de vencidos: "dame las que siguen abiertas y ya
    // deberían haber expirado".
    index("dispatch_offers_pending_idx").on(t.expiresAt, t.outcome),
  ],
);

// ---------------------------------------------------------------------------
// Tarifas por zona
// ---------------------------------------------------------------------------

/**
 * Las zonas (barrios) que la agencia cobra distinto. `keywords` son las
 * palabras con las que se reconoce una dirección de esa zona ("caney",
 * "cra 83") — el modelo elige la zona, y si no la reconoce, el código busca
 * estas palabras en el texto como respaldo.
 */
export const zones = pgTable("zones", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  keywords: jsonb("keywords").notNull().$type<string[]>().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** La matriz origen × destino = precio. Una fila por par de zonas. */
export const fares = pgTable(
  "fares",
  {
    id: serial("id").primaryKey(),
    originZoneId: integer("origin_zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    destinationZoneId: integer("destination_zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    price: integer("price").notNull(),
  },
  (t) => [uniqueIndex("fares_pair_idx").on(t.originZoneId, t.destinationZoneId)],
);

/** Ajustes sueltos de la agencia (por ahora: la tarifa cuando no se reconoce
 *  la zona). Clave/valor para no crear una tabla por cada número. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

/** Quienes entran al portal (despachadores y administradores). Sin registro
 *  público: los usuarios los crea el equipo con `npm run user:create`. */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** `scrypt$sal$hash`, ver `auth/password.ts`. */
  passwordHash: text("password_hash").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
