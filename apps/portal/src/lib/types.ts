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
  customerPhone: string | null;
  valueToCollect: number | null;
  paymentMethod: PaymentMethod | null;
  requiresCashReturn: boolean;
  deliveryFee: number;
  createdAt: string;
  updatedAt: string;
  courierName: string | null;
  courierId: number | null;
  courierPhone: string | null;
  assignedAt: string | null;
  deliveredAt: string | null;
  /** Cuándo el motorizado tocó «Vi el pedido». */
  seenAt?: string | null;
  /** Cuándo el bot le recordó que confirmara. */
  seenReminderAt?: string | null;
  /** Desde cuándo sale en rojo si sigue sin confirmar. */
  seenAlertAt?: string | null;
};

export type Courier = {
  id: number;
  name: string;
  phone: string;
  status: CourierStatus;
  lat: number | null;
  lng: number | null;
  locationUpdatedAt: string | null;
  deliveriesThisShift: number;
  lastAssignedAt: string | null;
  active: boolean;
  createdAt: string;
  /** Últimos 7 días: cuántos pedidos confirmó con «Vi el pedido», en cuántos
   *  minutos en promedio y cuántas veces hubo que recordárselo. */
  seenStats?: { confirmed: number; avgMinutes: number | null; reminders: number } | null;
};

export type CourierProfile = {
  vehiclePlate: string | null;
  vehicleType: string | null;
  documentId: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
};

export type SettlementRow = {
  courierId: number;
  courierName: string;
  deliveredCount: number;
  netEarnings: number;
  cashToDeliver: number;
};

export type Settlement = {
  netEarnings: number;
  deliveredCount: number;
  averageFee: number;
  byMethod: {
    cash: { orders: number; amount: number };
    transfer: { orders: number; amount: number };
  };
  couriers: SettlementRow[];
};

/** Un tramo de la tarifa por distancia; el último no tiene tope ("más de X km"). */
export type FareRange = { upToKm: number | null; price: number };

export type DraftFields = {
  origenRestaurante: string | null;
  direccionEntrega: string | null;
  telefonoCliente: string | null;
  valorACobrar: number | null;
  metodoPago: PaymentMethod | null;
};

export type AdvisorQueryItem = { indice: number; direccion: string; barrio: string | null; cliente: string | null };

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
