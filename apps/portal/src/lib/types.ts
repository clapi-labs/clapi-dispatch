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
  customerPhone: string;
  valueToCollect: number;
  paymentMethod: PaymentMethod;
  requiresCashReturn: boolean;
  deliveryFee: number;
  pickupZone: string | null;
  deliveryZone: string | null;
  createdAt: string;
  updatedAt: string;
  courierName: string | null;
  courierId: number | null;
  courierPhone: string | null;
  assignedAt: string | null;
  deliveredAt: string | null;
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

export type Zone = { id: number; name: string; keywords: string[]; sortOrder: number };
export type FareMatrix = {
  zones: Zone[];
  fares: { originZoneId: number; destinationZoneId: number; price: number }[];
  defaultFare: number;
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
  lastMessageAt: string;
  lastText: string | null;
  lastRole: "restaurant" | "bot" | "agent" | null;
};

export type ChatMessage = {
  id: number;
  role: "restaurant" | "bot" | "agent";
  text: string;
  createdAt: string;
};
