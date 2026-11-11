import { serviceVerdictAt, type LatLngPoint, type ServiceZoneShape } from "@dispatch/shared";

/**
 * Las zonas de servicio en la conversación (docs/DIRECCIONES-Y-ZONAS.md,
 * «Zonas de servicio en el bot»). Cuenta dónde se entrega:
 *
 * - dentro de una zona, o sin ninguna zona marcada → el pedido sigue normal;
 * - cerca del borde (300 m o menos) → no decide el bot: lo pregunta a la central;
 * - fuera y lejos → no hay servicio y esa entrega no se pide.
 *
 * Aquí están la decisión y los textos, sin base ni WhatsApp, para probarlos
 * solos; `order.ts` y `advisor.ts` los usan.
 */

export type Coverage = { kind: "ok" } | { kind: "cerca"; zone: string; meters: number } | { kind: "fuera" };

/** Qué pasa con una entrega en ese punto. Sin punto no hay cómo revisar: sigue
 *  normal (sin punto tampoco hay precio, y eso ya pasa por la central). */
export function coverageAt(point: LatLngPoint | null | undefined, zones: ServiceZoneShape[]): Coverage {
  if (!point) return { kind: "ok" };
  const verdict = serviceVerdictAt(point, zones);
  if (verdict.kind === "cerca") return { kind: "cerca", zone: verdict.zone.name, meters: Math.round(verdict.distanceM) };
  if (verdict.kind === "fuera") return { kind: "fuera" };
  return { kind: "ok" };
}

/** «a», «a y b», «a, b y c». */
function joinNames(names: string[]) {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

/** Al restaurante, por las entregas fuera de las zonas: no se piden. */
export function noServiceText(labels: string[]): string | null {
  if (!labels.length) return null;
  return `Qué pena, pero hasta ${joinNames(labels)} no manejamos domicilio 🙏`;
}

/** Al restaurante, mientras la central decide si se llega hasta allá. */
export function nearEdgeText(labels: string[]): string {
  return `Déjame confirmar con la central si llegamos hasta ${joinNames(labels)} 🙏 Te aviso en un momento.`;
}

/** Empieza así el motivo de una conversación pausada porque la entrega quedó
 *  cerca del borde de una zona de servicio. */
export const COVERAGE_QUERY_REASON = "Consulta de cobertura:";

/** El motivo que ve la central en el portal. */
export function coverageQueryReason(items: { address: string; zone: string; meters: number }[]): string {
  const list = items.map((i) => `«${i.address}» (a ${i.meters} m de «${i.zone}»)`).join(" y ");
  return `${COVERAGE_QUERY_REASON} ${list} ${items.length === 1 ? "queda" : "quedan"} fuera de las zonas de servicio, cerca del borde. ¿Se hace?`;
}
