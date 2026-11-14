import {
  boolean,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { Interpretation, OrderDraft, PaymentMethod } from "../domain/extraction";
import type { OfferOutcome } from "../domain/dispatch/types";
import type { DeliveryPlace, RouteStop } from "../domain/phase";

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
    draft: jsonb("draft").$type<OrderDraft>(),
    /** Cuántas veces se repreguntó por el pedido en curso. */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    /** El último mensaje entrante (`messages.id`) que el bot ya respondió. El
     *  bot espera unos segundos antes de responder y junta lo que llegó en
     *  ese tiempo: lo posterior a este id es lo que falta por procesar. */
    processedThroughMessageId: integer("processed_through_message_id"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    /** Cuándo se le dijo por última vez que estaba fuera de horario: el aviso
     *  no se repite hasta la próxima jornada (`domain/service-hours.ts`). */
    closedNoticeAt: timestamp("closed_notice_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_last_message_idx").on(t.lastMessageAt)],
);

export type MessageRole = "restaurant" | "bot" | "agent";

/** Lo que el bot necesita de un mensaje entrante para procesarlo más tarde. */
export type IncomingPayload = (
  | { kind: "text"; text: string }
  /** `mediaId`: el id de Meta para descargarla (en el chat simulado, una ruta local). */
  | { kind: "image"; mediaId: string; caption: string | null }
  | { kind: "button"; buttonId: string; title: string }
  | { kind: "location"; lat: number; lng: number; label: string | null }
  | { kind: "unsupported"; type: string }
) & {
  /** El wamid del mensaje que el restaurante citó, si respondió a uno. */
  replyTo?: string | null;
};

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
    /** El viaje del que habla este mensaje, si habla de uno. Cuando el
     *  restaurante responde citando un mensaje nuestro, por aquí se sabe a
     *  qué pedido se refiere. */
    tripId: integer("trip_id"),
    /** El wamid del mensaje que este cita (solo los que envía el bot o un
     *  asesor; lo que cita el restaurante va en `incoming.replyTo`). El portal
     *  lo muestra encima de la burbuja, como WhatsApp. */
    replyToWaMessageId: text("reply_to_wa_message_id"),
    /** El mensaje entrante tal como llegó (texto, botón o ubicación), para
     *  procesarlo después de la espera aunque `text` sea solo su resumen. */
    incoming: jsonb("incoming").$type<IncomingPayload>(),
    /** Lo que extrajo el modelo de este mensaje, antes de validar que esté
     *  completo. Queda guardado para poder auditar por qué un viaje pidió
     *  una repregunta. */
    extraction: jsonb("extraction").$type<Interpretation>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.id), index("messages_wa_message_idx").on(t.waMessageId)],
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
     *  con un nombre ligeramente distinto. Opcional: puede no tener WhatsApp. */
    phone: text("phone").unique(),
    /** Foto pequeña, como data URL. */
    photo: text("photo"),
    /** La dirección de recogida que más se repite para este restaurante.
     *  Se completa con la primera entrega confirmada y de ahí en adelante se
     *  usa como respaldo si el mensaje no la trae. */
    knownPickupAddress: text("known_pickup_address"),
    knownPickupLocation: jsonb("known_pickup_location").$type<{ lat: number; lng: number }>(),
    /** Lo que ayuda al motorizado a encontrar la recogida: "Local 12, entrada
     *  por el parqueadero". Va en la ficha junto a la dirección. */
    pickupDetail: text("pickup_detail"),
    /** Hasta qué hora recibe servicios, "HH:MM" de Cali (puede pasar la
     *  medianoche). Null: la hora límite por defecto de la agencia. */
    orderDeadline: text("order_deadline"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("restaurants_phone_idx").on(t.phone)],
);

// ---------------------------------------------------------------------------
// Viajes
// ---------------------------------------------------------------------------

export type TripStatus = "pending" | "assigned" | "en_route" | "delivered" | "cancelled";

/** El contador del código de cada pedido (`B-12`): de 0 (A-00) a 2599 (Z-99)
 *  y vuelve a empezar. Ver `trip-code.ts`. */
export const tripCodeSeq = pgSequence("trip_code_seq", { startWith: 0, minValue: 0, maxValue: 2599, cycle: true });

export const trips = pgTable(
  "trips",
  {
    id: serial("id").primaryKey(),
    /** Se repite cada 2.600 pedidos: no es único. */
    code: text("code").notNull(),

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

    /** Del cliente final. Opcionales: cada agencia decide qué datos exige
     *  (`settings.bot_config`); si el restaurante los da, se guardan. */
    customerPhone: text("customer_phone"),
    customerName: text("customer_name"),
    valueToCollect: integer("value_to_collect"),
    /** Lo que cobra la agencia por el domicilio: su ganancia. Sale de la
     *  tabla por km más el ajuste de la zona de la entrega, y se congela al
     *  crear el viaje — cambiar la tarifa mañana no reescribe el arqueo de hoy. */
    deliveryFee: integer("delivery_fee").notNull().default(0),
    /** Los km con que se cotizó, congelados como el precio: el portal muestra
     *  estos. Nulos si el precio lo puso la central sin distancia, o en los
     *  viajes de antes de este dato (ahí se calculan en línea recta × 1,3). */
    routeKm: real("route_km"),
    /** `calle` (OSRM) o `linea_recta` (interruptor apagado, o respaldo porque
     *  OSRM no respondió). */
    routeSource: text("route_source").$type<"calle" | "linea_recta">(),
    /** El desglose del precio, congelado como él (docs/DIRECCIONES-Y-ZONAS.md,
     *  «Precio del domicilio»): lo de la tabla por km, el ajuste de la zona de
     *  la entrega y el nombre de esa zona. Nulos si el precio lo puso la
     *  central, o en los viajes de antes de este dato. */
    fareTablePrice: integer("fare_table_price"),
    fareAdjustment: integer("fare_adjustment"),
    fareZoneName: text("fare_zone_name"),
    pickupZone: text("pickup_zone"),
    deliveryZone: text("delivery_zone"),
    paymentMethod: text("payment_method").$type<PaymentMethod>(),
    /** Sin uso: no se puede deducir el regreso del método de pago, porque
     *  depende de la base o del datáfono. Lo dice el domiciliario al entregar
     *  (`assignments.return_started_at`). */
    requiresCashReturn: boolean("requires_cash_return").notNull().default(false),
    /** Lo que el motorizado debe saber y no es un campo: "billete de 100
     *  mil", "torre A apto 705", "2 hamburguesas". */
    notes: text("notes"),
    /** El mensaje de WhatsApp del restaurante que abrió el pedido. Los avisos
     *  sobre el viaje le responden citándolo. */
    sourceWaMessageId: text("source_wa_message_id"),
    /** Cuándo está lista la comida, como hora exacta: el restaurante dice
     *  "listo en 15" y se guarda la hora, para que el engine sepa cuánto
     *  falta cada vez que evalúa. Nulo en los viajes anteriores a este dato. */
    readyAt: timestamp("ready_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trips_status_idx").on(t.status),
    index("trips_restaurant_idx").on(t.restaurantId),
    // El restaurante nombra el pedido por su código (bot: tripFromCodeInText).
    index("trips_conversation_code_idx").on(t.conversationId, t.code),
    // El tablero trae los activos y los que se movieron hoy (portal: listTrips).
    index("trips_updated_idx").on(t.updatedAt),
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
  /** Foto pequeña, como data URL. */
  photo: text("photo"),
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
  /** Moto del simulador de staging (docs/OPERACION.md): una fila más para el
   *  algoritmo y el portal, con un número que no existe. Solo se usa con
   *  `SIMULATOR_ENABLED`. */
  simulated: boolean("simulated").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Simulador de staging: qué moto simulada controla cada número de prueba (una
 * moto con número real de Flota). Sin moto (`sim_courier_id` nulo), el número
 * está libre desde `since`; con moto, la controla desde `since`. Ver
 * `db/simulator.ts`.
 */
export const simulatorControls = pgTable("simulator_controls", {
  phoneCourierId: integer("phone_courier_id")
    .primaryKey()
    .references(() => couriers.id, { onDelete: "cascade" }),
  simCourierId: integer("sim_courier_id")
    .unique()
    .references(() => couriers.id, { onDelete: "set null" }),
  since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
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
  /** El identificador con que su celular reporta el GPS. Aleatorio y difícil de
   *  adivinar: es lo único que autoriza a reportar la posición de esta moto. */
  gpsDeviceId: text("gps_device_id").unique(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** El orden en que la moto hace sus paradas: el `plan` del engine en su última
 *  asignación. Solo el orden: qué le falta sale de la fase de cada viaje
 *  (`domain/phase`), y así lo ya hecho no hay que borrarlo de aquí. */
export const courierRoutes = pgTable("courier_routes", {
  courierId: integer("courier_id")
    .primaryKey()
    .references(() => couriers.id, { onDelete: "cascade" }),
  stops: jsonb("stops").notNull().$type<RouteStop[]>(),
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
    /** Cuándo WhatsApp avisó que leyó el mensaje. Nulo no prueba que no lo
     *  viera: hay quien tiene apagada la confirmación de lectura. */
    readAt: timestamp("read_at", { withTimezone: true }),
    /** Cuándo el motorizado tocó «Voy en camino». Sin esto la central no sabe
     *  si ya salió o si el pedido se está enfriando. */
    seenAt: timestamp("seen_at", { withTimezone: true }),
    /** Cuándo se le recordó que confirmara (una sola vez por asignación). */
    seenReminderAt: timestamp("seen_reminder_at", { withTimezone: true }),
    /** A qué distancia de la recogida estaba en su primer reporte de GPS: si
     *  se acerca, ya salió aunque no haya tocado «Voy en camino». */
    startDistanceM: real("start_distance_m"),
    /** Cuándo el GPS lo vio llegar a la recogida. */
    atPickupAt: timestamp("at_pickup_at", { withTimezone: true }),
    /** Cuándo tocó «Recogí», o cuándo el GPS lo vio salir de la recogida. Nulo si
     *  marcó la entrega sin nada de eso. */
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    /** Cuándo se le recordó que ya está listo (una sola vez por asignación). */
    pickupReminderAt: timestamp("pickup_reminder_at", { withTimezone: true }),
    /** Cuándo el GPS lo vio llegar a la entrega, y salir sin haberla marcado. */
    atDeliveryAt: timestamp("at_delivery_at", { withTimezone: true }),
    leftDeliveryAt: timestamp("left_delivery_at", { withTimezone: true }),
    /** Cuándo avisó que el cliente no contesta: empieza la espera. */
    customerWaitAt: timestamp("customer_wait_at", { withTimezone: true }),
    /** Pasó la espera: va de regreso a devolver el pedido. */
    undeliveredAt: timestamp("undelivered_at", { withTimezone: true }),
    /** La hora real de la entrega, aunque después tenga que volver. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryPlace: text("delivery_place").$type<DeliveryPlace>(),
    /** Entregó y debe volver a recogida: sigue ocupado hasta `finishedAt`. */
    returnStartedAt: timestamp("return_started_at", { withTimezone: true }),
    /** Cuándo terminó el servicio y quedó libre. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
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

/**
 * Modo sombra del engine (docs/ALGORITMO.md): a quién y cuándo habría
 * asignado cada viaje, sin asignar. Una fila por viaje que se actualiza en
 * cada tick mientras el pedido "espera" (faltan minutos para despacharlo) y
 * se congela al decidir. La asignación real está en `assignments`: se
 * comparan con un join por `trip_id`.
 *
 * - `waiting`: aún no es hora de despachar, faltan datos o no hay motos.
 * - `decided`: llegó la hora y el engine eligió (`courier_id`).
 * - `expired`: se dejó de evaluar sin decidir (viaje cerrado o muy viejo).
 */
export type EngineEvaluationStatus = "waiting" | "decided" | "expired";

export const engineEvaluations = pgTable(
  "engine_evaluations",
  {
    id: serial("id").primaryKey(),
    tripId: integer("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    status: text("status").notNull().$type<EngineEvaluationStatus>().default("waiting"),
    /** Por qué sigue esperando o expiró: faltan datos, sin motos, engine caído… */
    reason: text("reason"),
    courierId: integer("courier_id").references(() => couriers.id, { onDelete: "set null" }),
    faltanMin: real("faltan_min"),
    dispatchAt: timestamp("dispatch_at", { withTimezone: true }),
    engineVersion: text("engine_version"),
    /** La última petición y respuesta de /evaluar, tal cual: sirven para
     *  explicar la decisión y para repetirla con otra versión del engine. */
    request: jsonb("request"),
    response: jsonb("response"),
    evaluations: integer("evaluations").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("engine_evaluations_trip_idx").on(t.tripId), index("engine_evaluations_status_idx").on(t.status)],
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

/**
 * Zonas de servicio (docs/DIRECCIONES-Y-ZONAS.md, «Zonas de servicio»): donde
 * sí hay domicilio. La central las marca en el mapa del portal (/zonas); lo
 * que queda por fuera no tiene servicio. Iguales para todos los restaurantes,
 * cuenta dónde se entrega y pueden cruzarse (`domain/service-zones.ts`). Cada
 * una tiene un ajuste fijo de precio (`fareAdjustment`, `domain/fare.ts`).
 *
 * Son datos de la central: ninguna migración ni despliegue las borra o las
 * cambia (lo revisa `db/service-zones-guard.test.ts`). Cada cambio queda en
 * `service_zone_versions`.
 */
export const serviceZones = pgTable("service_zones", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** El contorno, en orden y sin repetir el primero: de 3 a 500 puntos. */
  ring: jsonb("ring").$type<{ lat: number; lng: number }[]>().notNull(),
  /** El barrio del que salió, si salió de uno (código de `barrios.json`). */
  barrioCode: text("barrio_code"),
  /** Pesos que se suman (o restan, si es negativo) al precio de la tabla por
   *  km cuando la entrega queda en esta zona. El total nunca baja de 0. */
  fareAdjustment: integer("fare_adjustment").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Cada versión de cada zona de servicio, también la última antes de borrarla:
 * con esto una zona borrada o cambiada sin querer se puede recuperar. Sin
 * llave foránea, para que sobreviva a la zona.
 */
export const serviceZoneVersions = pgTable(
  "service_zone_versions",
  {
    id: serial("id").primaryKey(),
    zoneId: integer("zone_id").notNull(),
    /** "creada", "editada" o "borrada". */
    action: text("action").notNull(),
    name: text("name").notNull(),
    ring: jsonb("ring").$type<{ lat: number; lng: number }[]>().notNull(),
    barrioCode: text("barrio_code"),
    /** El ajuste de precio de esa versión (nulo en las de antes de este dato). */
    fareAdjustment: integer("fare_adjustment"),
    /** Quién lo hizo en el portal, si se sabe. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("service_zone_versions_zone_idx").on(t.zoneId)],
);

// ---------------------------------------------------------------------------
// Sesiones del portal y alertas al celular (docs/INTERVENCION-MANUAL.md,
// «Alertas al celular»)
// ---------------------------------------------------------------------------

/**
 * Cada inicio de sesión en el portal. La cookie va firmada y lleva este id: si
 * la fila ya no existe, la sesión se cerró (desde ese mismo equipo o a
 * distancia, por ejemplo si se pierde el celular). En un computador dura 12
 * horas; en el portal instalado en un celular, 30 días.
 */
export const portalSessions = pgTable(
  "portal_sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Abierta desde el portal instalado como app (pantalla de inicio). */
    installed: boolean("installed").notNull().default(false),
    /** Para reconocerla en la lista: «Android · Chrome», «iPhone»… */
    device: text("device").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("portal_sessions_user_idx").on(t.userId)],
);

/**
 * Dónde mandar las alertas: una fila por navegador o celular que las activó.
 * Cuelga de la sesión: al cerrarla (o al vencer) el celular deja de recibirlas.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => portalSessions.id, { onDelete: "cascade" }),
    /** La dirección del servicio de notificaciones (Google, Apple, Mozilla). */
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** El portal desde el que se activó (https://…): Apple lo exige como remitente. */
    origin: text("origin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("push_subscriptions_session_idx").on(t.sessionId)],
);

/**
 * Qué alertas ya se avisaron al celular. Una alerta suena cuando algo entra en
 * su condición (un chat empieza a pedir ayuda, un viaje queda con moto), igual
 * que en el portal abierto: `active` dice si hoy está dentro. Pasar de
 * inactiva a activa con un UPDATE condicional es lo que manda el aviso, así
 * dos ticks en paralelo nunca avisan dos veces (`push/alerts.ts`).
 */
export const pushAlertState = pgTable(
  "push_alert_state",
  {
    /** El tipo de alerta: "chat_help", "trip_assigned"… */
    kind: text("kind").notNull(),
    /** El id de lo que avisa (la conversación, el viaje). */
    ref: integer("ref").notNull(),
    active: boolean("active").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("push_alert_state_pk").on(t.kind, t.ref)],
);
