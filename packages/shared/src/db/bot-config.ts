import { eq } from "drizzle-orm";

import { DEFAULT_REQUIRED_FIELDS, type OrderFieldKey } from "../domain/extraction";
import { db } from "./client";
import { settings } from "./schema";

export const BOT_CONFIG_KEY = "bot_config";

/**
 * Lo que cambia de una agencia a otra en la conversación. El flujo es el
 * mismo para todas (docs/BOT.md); esto es lo que cada una ajusta.
 */
export type BotConfig = {
  /** Lo que hace falta para crear el viaje después de confirmar. */
  requiredFields: OrderFieldKey[];
  /** Distancia máxima por calles desde el restaurante; más lejos no hay
   *  cobertura. `null` = sin tope. */
  maxKm: number | null;
  /** Avisarle al restaurante cuando el motorizado entrega. Cada aviso es un
   *  mensaje cobrado: la agencia decide si lo vale. El de portería sale
   *  siempre, porque el restaurante tiene que avisarle a su cliente. */
  notifyRestaurantOnDelivery: boolean;
  /** Confirmarle al motorizado que quedó registrado que terminó el servicio,
   *  salvo que ya le haya llegado otro pedido. Es un mensaje más por servicio. */
  confirmDeliveryToCourier: boolean;
  /** Decirle al restaurante quién va, cuando la moto se asigna después de
   *  confirmar. Con el engine es lo normal: espera a que la comida casi esté. */
  notifyRestaurantOnAssign: boolean;
  /** Enviarle «Recogí» en un mensaje aparte cuando toca «Voy en camino». Solo
   *  hace falta si WhatsApp desactiva los otros botones del mensaje al tocar
   *  uno: suma un mensaje por servicio. */
  pickupButtonAfterGoing: boolean;
  /** Minutos sin tocar «Voy en camino» antes de recordárselo al motorizado. */
  seenReminderMinutes: number;
  /** Minutos sin tocar «Voy en camino» antes de marcar el viaje en rojo en el
   *  tablero para que la central lo llame o le pase el pedido a otra moto. */
  seenAlertMinutes: number;
  /** El recordatorio no sale antes de estos minutos previos a que la comida
   *  esté lista: la cola asigna aunque falte media hora. */
  readyLeadMinutes: number;
  /** Minutos después de la hora de listo sin «Recogí»: recordatorio y alerta. */
  pickupLateMinutes: number;
  /** Minutos después de «Recogí» sin marcar la entrega: alerta. */
  deliveryAlertMinutes: number;
  /** Minutos de regreso sin «Ya volví»: alerta. */
  returnAlertMinutes: number;
  /** Cuánto espera a un cliente que no contesta antes de devolver el pedido. */
  customerWaitMinutes: number;
  /** A esta distancia del punto, el GPS cuenta que llegó. */
  gpsArrivalMeters: number;
  /** Menos tiempo que esto dentro del punto es que solo pasó por ahí. */
  gpsDwellSeconds: number;
  /** Acercarse esto a la recogida cuenta como «Voy en camino». */
  gpsDepartureMeters: number;
};

export const DEFAULT_BOT_CONFIG: BotConfig = {
  requiredFields: DEFAULT_REQUIRED_FIELDS,
  maxKm: 15,
  notifyRestaurantOnDelivery: true,
  confirmDeliveryToCourier: true,
  notifyRestaurantOnAssign: true,
  pickupButtonAfterGoing: false,
  seenReminderMinutes: 3,
  seenAlertMinutes: 6,
  readyLeadMinutes: 10,
  pickupLateMinutes: 10,
  deliveryAlertMinutes: 30,
  returnAlertMinutes: 20,
  customerWaitMinutes: 10,
  gpsArrivalMeters: 100,
  gpsDwellSeconds: 60,
  gpsDepartureMeters: 200,
};

const positive = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);

/** La configuración guardada, con los valores por defecto en lo que falte. */
export async function getBotConfig(): Promise<BotConfig> {
  const [row] = await db.select().from(settings).where(eq(settings.key, BOT_CONFIG_KEY));
  const saved = (row?.value ?? {}) as Partial<BotConfig>;
  return {
    requiredFields: Array.isArray(saved.requiredFields) ? saved.requiredFields : DEFAULT_BOT_CONFIG.requiredFields,
    maxKm: saved.maxKm === null || typeof saved.maxKm === "number" ? saved.maxKm : DEFAULT_BOT_CONFIG.maxKm,
    notifyRestaurantOnDelivery:
      typeof saved.notifyRestaurantOnDelivery === "boolean" ? saved.notifyRestaurantOnDelivery : DEFAULT_BOT_CONFIG.notifyRestaurantOnDelivery,
    confirmDeliveryToCourier:
      typeof saved.confirmDeliveryToCourier === "boolean" ? saved.confirmDeliveryToCourier : DEFAULT_BOT_CONFIG.confirmDeliveryToCourier,
    notifyRestaurantOnAssign: typeof saved.notifyRestaurantOnAssign === "boolean" ? saved.notifyRestaurantOnAssign : DEFAULT_BOT_CONFIG.notifyRestaurantOnAssign,
    pickupButtonAfterGoing: typeof saved.pickupButtonAfterGoing === "boolean" ? saved.pickupButtonAfterGoing : DEFAULT_BOT_CONFIG.pickupButtonAfterGoing,
    seenReminderMinutes: positive(saved.seenReminderMinutes) ?? DEFAULT_BOT_CONFIG.seenReminderMinutes,
    seenAlertMinutes: positive(saved.seenAlertMinutes) ?? DEFAULT_BOT_CONFIG.seenAlertMinutes,
    readyLeadMinutes: positive(saved.readyLeadMinutes) ?? DEFAULT_BOT_CONFIG.readyLeadMinutes,
    pickupLateMinutes: positive(saved.pickupLateMinutes) ?? DEFAULT_BOT_CONFIG.pickupLateMinutes,
    deliveryAlertMinutes: positive(saved.deliveryAlertMinutes) ?? DEFAULT_BOT_CONFIG.deliveryAlertMinutes,
    returnAlertMinutes: positive(saved.returnAlertMinutes) ?? DEFAULT_BOT_CONFIG.returnAlertMinutes,
    customerWaitMinutes: positive(saved.customerWaitMinutes) ?? DEFAULT_BOT_CONFIG.customerWaitMinutes,
    gpsArrivalMeters: positive(saved.gpsArrivalMeters) ?? DEFAULT_BOT_CONFIG.gpsArrivalMeters,
    gpsDwellSeconds: positive(saved.gpsDwellSeconds) ?? DEFAULT_BOT_CONFIG.gpsDwellSeconds,
    gpsDepartureMeters: positive(saved.gpsDepartureMeters) ?? DEFAULT_BOT_CONFIG.gpsDepartureMeters,
  };
}
