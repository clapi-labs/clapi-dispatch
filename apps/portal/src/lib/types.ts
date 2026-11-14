export type TripStatus = "pending" | "assigned" | "en_route" | "delivered" | "cancelled";
export type PaymentMethod = "efectivo" | "transferencia";
export type CourierStatus = "available" | "busy" | "paused" | "offline";

export type Trip = {
  id: number;
  code: string;
  status: TripStatus;
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
  routeSource?: "calle" | "linea_recta" | null;
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
  /** Tiene identificador de GPS: su celular reporta la ubicación. */
  hasGps?: boolean;
  /** Con el simulador: moto simulada, número de prueba o moto real con GPS, y
   *  con quién va ahora. */
  simulator?: { role: "simulated" | "test" | "real"; partner: string | null } | null;
};

export type CourierProfile = {
  vehiclePlate: string | null;
  vehicleType: string | null;
  documentId: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  /** Lo que se configura en la app de su celular para reportar el GPS. */
  gpsDeviceId?: string | null;
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

export type ChatMessage = {
  id: number;
  role: "restaurant" | "bot" | "agent";
  text: string;
  createdAt: string;
  /** El mensaje que este cita, como en WhatsApp. */
  quote?: { id: number; role: "restaurant" | "bot" | "agent"; text: string } | null;
  /** Los códigos de los pedidos que salieron de este mensaje del restaurante. */
  tripCodes?: string[];
};
