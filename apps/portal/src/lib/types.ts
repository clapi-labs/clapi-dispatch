export type TripStatus = "pending" | "assigned" | "en_route" | "delivered" | "cancelled";
/** `errand`: un encargo (comprarle o traerle algo al restaurante). Lo asigna solo la central. */
export type TripKind = "delivery" | "errand";
export type PaymentMethod = "efectivo" | "transferencia" | "datafono";
export type CourierStatus = "available" | "busy" | "paused" | "offline";

export type Trip = {
  id: number;
  code: string;
  status: TripStatus;
  /** Sin el dato (datos de ejemplo viejos), un domicilio. */
  kind?: TripKind;
  originRestaurantName: string;
  pickupAddress: string | null;
  deliveryAddress: string;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  valueToCollect: number | null;
  paymentMethod: PaymentMethod | null;
  requiresCashReturn: boolean;
  deliveryFee: number;
  distanceKm: number | null;
  /** `calle` (OSRM) o `linea_recta`; nulo si no se midió. */
  routeSource?: "google" | "calle" | "linea_recta" | null;
  /** De dónde sale `deliveryFee`: tabla por km y ajuste de la zona de la
   *  entrega. Nulos si el precio lo puso la central o es de antes del dato. */
  fareTablePrice?: number | null;
  fareAdjustment?: number | null;
  fareZoneName?: string | null;
  createdAt: string;
  updatedAt: string;
  courierName: string | null;
  courierId: number | null;
  courierPhone: string | null;
  assignedAt: string | null;
  deliveredAt: string | null;
  /** Cuándo WhatsApp avisó que leyó el mensaje. */
  readAt?: string | null;
  /** Cuándo el motorizado tocó «Voy en camino». */
  seenAt?: string | null;
  /** Cuándo el bot le recordó «Voy en camino». */
  seenReminderAt?: string | null;
  /** Cuándo el GPS lo vio llegar a la recogida. */
  atPickupAt?: string | null;
  /** Cuándo tocó «Recogí», o cuándo el GPS lo vio salir de la recogida. */
  pickedUpAt?: string | null;
  /** Cuándo el GPS lo vio llegar a la entrega, y salir sin haberla marcado. */
  atDeliveryAt?: string | null;
  leftDeliveryAt?: string | null;
  /** Avisó que el cliente no contesta, y cuándo pasó a devolver el pedido. */
  customerWaitAt?: string | null;
  undeliveredAt?: string | null;
  /** Cuándo el bot le recordó que ya estaba listo. */
  pickupReminderAt?: string | null;
  deliveryPlace?: "customer" | "gate" | null;
  /** Entregó y está volviendo a recogida. */
  returnStartedAt?: string | null;
  finishedAt?: string | null;
  /** Desde cuándo sale en rojo si sigue en esa fase. */
  alertAt?: string | null;
  /** El bloqueo real del viaje (el que avisa al celular) y desde cuándo. */
  blockageKind?: "customer_no_answer" | "pickup_late" | "delivery_late" | "return_late" | null;
  blockageAt?: string | null;
  /** Con el engine asignando: por qué sigue pendiente, y cuándo se despacha. */
  dispatchNote?: string | null;
  dispatchAt?: string | null;
  pickupLocation?: { lat: number; lng: number } | null;
};

export type Courier = {
  id: number;
  name: string;
  phone: string;
  photo: string | null;
  status: CourierStatus;
  lat: number | null;
  lng: number | null;
  locationUpdatedAt: string | null;
  locationMoving?: boolean | null;
  deliveriesThisShift: number;
  lastAssignedAt: string | null;
  active: boolean;
  createdAt: string;
  /** Últimos 7 días: cuántos pedidos confirmó con «Voy en camino», en cuántos
   *  minutos en promedio y cuántas veces hubo que recordárselo. */
  seenStats?: { confirmed: number; avgMinutes: number | null; reminders: number } | null;
  /** Moto simulada del simulador de staging. */
  simulated?: boolean;
  /** Si la central puede asignarle pedidos (con el simulador: las simuladas y,
   *  para un viaje de prueba, las reales con GPS). */
  assignable?: boolean;
  /** Administrador de la agencia que también domicilia: prioridad sutil en la asignación (#120). */
  isAdmin?: boolean;
  /** Tiene identificador de GPS: su celular reporta la ubicación. */
  hasGps?: boolean;
  /** Con el simulador: moto simulada, número de prueba o moto real con GPS, y
   *  con quién va ahora. */
  simulator?: { role: "simulated" | "test" | "real"; partner: string | null } | null;
  /** Pendientes de regreso abiertos, por motivo (Pendientes). */
  returnDebts?: { datafono: number; plata: number } | null;
  /** Su ruta en orden, con los regresos al restaurante como paradas (`B`). */
  route?: { kind: "R" | "C" | "W" | "V" | "B"; text: string }[];
};

/** Un pendiente de regreso, como lo manda `/api/pendientes`. */
export type ReturnDebt = {
  id: number;
  courierId: number;
  courierName: string;
  restaurantId: number | null;
  restaurantName: string;
  reason: "datafono" | "plata";
  tripId: number | null;
  tripCode: string | null;
  createdAt: string;
  deliveredAt: string | null;
  declaredBy: "courier" | "central";
  reminderAt: string | null;
  claimedAt?: string | null;
  closingNotifiedAt?: string | null;
  resolvedAt: string | null;
  resolvedBy: "courier" | "central" | null;
  resolvedByName: string | null;
};

export type ReturnDebtClaim = {
  id: number;
  restaurantId: number | null;
  restaurantName: string;
  conversationId: number | null;
  reason: "datafono" | "plata" | null;
  closing: boolean;
  why: string;
  createdAt: string;
  updatedAt: string;
};

export type ReturnDebtsData = {
  open: ReturnDebt[];
  resolved: ReturnDebt[];
  claims: ReturnDebtClaim[];
  datafonoAlertMinutes: number;
  closingDebtMinutes: number;
};

export type CourierProfile = {
  vehiclePlate: string | null;
  vehicleType: string | null;
  documentId: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  /** Lo que se configura en la app de su celular para reportar el GPS. */
  gpsDeviceId?: string | null;
  /** Cuándo autorizó el uso de datos y ubicación GPS (Ley 1581). */
  gpsConsentAt?: string | null;
  /** Cuándo completó la activación inicial por WhatsApp con señal GPS verificada. */
  onboardingCompletedAt?: string | null;
};

export type SettlementRow = {
  courierId: number;
  courierName: string;
  deliveredCount: number;
  /** Lo que generó en domicilios hoy. */
  earned: number;
  /** El porcentaje de la agencia sobre lo que generó. */
  agencyShare: number;
};

/** El cierre del día: solo los domicilios. El valor del pedido es del
 *  restaurante y no entra. */
export type Settlement = {
  total: number;
  deliveredCount: number;
  averageFee: number;
  /** 0.1 = 10 %. */
  agencyRate: number;
  agencyShare: number;
  couriers: SettlementRow[];
  /** Solo si se pidió una semana (`?semana=` o `?dia=`): lunes y domingo, `YYYY-MM-DD`. */
  week?: { start: string; end: string };
  /** Solo si se pidió una semana: lunes a domingo, siempre 7. */
  days?: SettlementDay[];
  /** Solo si se pidió un día: ese día; si no, el resumen es de toda la semana. */
  day?: string | null;
};

/** Un día de la semana en el resumen de Finanzas. */
export type SettlementDay = {
  /** `YYYY-MM-DD`, hora de Colombia. */
  date: string;
  deliveredCount: number;
  total: number;
  agencyShare: number;
};

/** Un tramo de la tarifa por distancia; el último no tiene tope ("más de X km"). */
export type { FareRange } from "@dispatch/shared/domain/fare";

export type DraftFields = {
  origenRestaurante: string | null;
  direccionEntrega: string | null;
  telefonoCliente: string | null;
  valorACobrar: number | null;
  metodoPago: PaymentMethod | null;
};

/** Lo que el bot le preguntó a la central de una entrega. `cobertura`: la
 *  entrega quedó fuera de las zonas de servicio, cerca del borde de `zona`
 *  (¿se hace?); `precio` es lo que vale por km. Sin `cobertura`: el mapa no
 *  ubicó la dirección (¿es válida y cuánto vale?). */
export type AdvisorQueryItem = {
  indice: number;
  direccion: string;
  barrio: string | null;
  cliente: string | null;
  /** `km`: con los que se cotizó (`porCalle`: medidos por calle). */
  cobertura?: { zona: string; metros: number; precio: number; km: number | null; porCalle: boolean } | null;
};

export type ConversationKind = "restaurant" | "courier";

export type ConversationSummary = {
  id: number;
  phone: string;
  displayName: string | null;
  kind: ConversationKind;
  courierName: string | null;
  restaurantName?: string | null;
  photo?: string | null;
  botPaused: boolean;
  escalationReason: string | null;
  draft: DraftFields | null;
  /** Las direcciones que el bot no pudo ubicar y le preguntó a la central:
   *  el asesor dice si son válidas y cuánto vale el domicilio. */
  advisorQuery?: AdvisorQueryItem[] | null;
  lastMessageAt: string;
  lastText: string | null;
  lastRole: "restaurant" | "bot" | "agent" | null;
};

/** La foto de un mensaje: en disco (se ve) o ya borrada por la limpieza (se avisa). */
export type ChatMedia =
  | {
      status: "stored";
      mime: string;
      width: number | null;
      height: number | null;
      bytes: number;
      /** Solo el modo demo: una imagen incrustada en lugar de pedirla al servidor. */
      src?: string;
    }
  | { status: "expired"; reason: "ttl" | "space" | null; retentionDays: number };

export type ChatMessage = {
  id: number;
  role: "restaurant" | "bot" | "agent";
  text: string;
  createdAt: string;
  /** El mensaje que este cita, como en WhatsApp. */
  quote?: { id: number; role: "restaurant" | "bot" | "agent"; text: string } | null;
  /** Los códigos de los pedidos que salieron de este mensaje del restaurante. */
  tripCodes?: string[];
  /** La foto que trae el mensaje, si trae una. */
  media?: ChatMedia | null;
};
