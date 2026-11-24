/**
 * Un domiciliario que la central quitó de la flota (Flota, «Quitar de la
 * flota») ya no recibe servicios, pero su número sigue siendo el de un
 * domiciliario: si escribe, no es un restaurante nuevo ni un número
 * desconocido. Al quitarlo se le avisa; si después escribe, el bot le contesta
 * que ya no está en la flota y su chat pasa a la central con este motivo. La
 * central decide si lo vuelve a agregar: con el mismo número se reactiva su
 * ficha de antes y el chat vuelve al bot.
 */

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Con qué empieza el motivo del chat de un domiciliario quitado que escribió:
 *  así lo reconocen el portal y la alerta al celular. */
export const REMOVED_COURIER_REASON_PREFIX = "Quitado de la flota:";

export function removedCourierReason(name: string): string {
  return `${REMOVED_COURIER_REASON_PREFIX} ${name.trim()} pide volver. Si lo agregas de nuevo en Flota con el mismo número, vuelve con su historial.`;
}

export function isRemovedCourierReason(reason: string | null | undefined): boolean {
  return !!reason?.startsWith(REMOVED_COURIER_REASON_PREFIX);
}

/** El aviso que le llega al quitarlo de la flota. */
export function courierRemovedText(name: string): string {
  return `${firstName(name)}, la central te quitó de la flota: desde ya no te llegan servicios. Si quieres volver, escríbeme Hola y le aviso a la central 🙏`;
}

/** Lo que se le responde si escribe estando fuera de la flota. */
export function removedCourierHoldText(name: string): string {
  return `Hola ${firstName(name)} 👋 Ya no estás en la flota, así que por ahora no te llegan servicios. Le avisé a la central que quieres volver: te confirman por aquí 🙏`;
}
