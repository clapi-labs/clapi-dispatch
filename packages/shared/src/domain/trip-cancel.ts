/**
 * La central cancela un viaje desde el portal (docs/INTERVENCION-MANUAL.md,
 * «Cancelar»). La regla del cobro es la de la agencia: si la moto ya salió del
 * restaurante con el pedido, el restaurante paga el domicilio; si lo cancelan
 * antes, no. La central puede cambiarlo en un caso especial (un accidente).
 *
 * Lo cobrado cuenta en Finanzas como un viaje más de esa moto, y la agencia
 * saca su parte igual que de una entrega.
 */

/** Los motivos de un toque; «Otro» deja escribirlo. */
export const CANCEL_REASONS = ["Lo pidió el restaurante", "El cliente canceló", "Accidente o novedad de la moto", "Pedido duplicado o de prueba"] as const;

/** Si por regla se cobra: la moto ya salió del restaurante con el pedido. Un
 *  encargo no tiene recogida marcada: lo decide la central. */
export function chargesOnCancel(trip: { kind?: "delivery" | "errand"; pickedUpAt?: Date | string | null }): boolean {
  return trip.kind !== "errand" && !!trip.pickedUpAt;
}

const cop = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);

/** Al domiciliario que lo llevaba. Con el pedido en la mano, que no lo deje
 *  botado: la central le dice qué hacer con él. */
export function courierCancelledText({ code, errand, pickedUp }: { code: string; errand: boolean; pickedUp: boolean }): string {
  if (errand) return `❌ La central canceló el encargo ${code}: ya no lo hagas 🙏`;
  if (pickedUp) return `❌ La central canceló el ${code}. Si tienes el pedido contigo, la central te dice qué hacer con él 🙏`;
  return `❌ La central canceló el ${code}: ya no lo llevas, no vayas a recogerlo 🙏`;
}

/** Al restaurante, si la central deja la casilla marcada. Si se cobra, le dice
 *  cuánto y por qué. */
export function restaurantCancelledText({ code, errand, charged }: { code: string; errand: boolean; charged: number | null }): string {
  const done = `❌ Tu ${errand ? "encargo" : "pedido"} ${code} quedó cancelado.`;
  if (!charged) return done;
  return `${done} Como el domiciliario ya había salido, se cobra el domicilio: ${cop(charged)}.`;
}
