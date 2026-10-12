import type { ConversationKind } from "@/lib/types";

/**
 * Respuestas frecuentes de la central, según con quién se habla. Son textos
 * fijos: para cambiarlos o sumar otros basta editar esta lista.
 */
export const QUICK_REPLIES: Record<ConversationKind, string[]> = {
  restaurant: [
    "Recibido, ya lo revisamos.",
    "¿Me confirmas la dirección de recogida?",
    "¿Me confirmas la dirección de entrega y el teléfono del cliente?",
    "¿Cómo paga el cliente: efectivo o transferencia?",
    "Pago confirmado, gracias.",
    "Ya hay motorizado asignado: va en camino a recoger.",
  ],
  courier: [
    "Recibido, gracias.",
    "¿Ya recogiste el pedido?",
    "Avísame apenas entregues, por favor.",
    "¿Por dónde vas? Comparte tu ubicación.",
    "El cliente paga en efectivo: recuerda cobrar.",
  ],
};
