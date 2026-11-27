import { debtCloseButtonTitle, type DeliveryPlace, type ReturnDebtReason } from "@dispatch/shared";

/**
 * Los botones del motorizado (docs/FLUJO-DOMICILIARIO.md): qué ids llevan y qué
 * significa cada toque. Sin base ni WhatsApp, para probarlos solos; `notify.ts`
 * los manda y `courier.ts` los atiende.
 */

const GOING_PREFIX = "going:";
const PICKED_PREFIX = "picked:";
/** «Recogí» con un pendiente: `pickdebt:datafono:12`, `pickdebt:plata:12`. */
const PICK_DEBT_PREFIX = "pickdebt:";
/** Cierra un pendiente (y su grupo): `debtok:5`. */
const DEBT_DONE_PREFIX = "debtok:";
const DONE_PREFIX = "done:";
/** «Ya volví», de antes de los pendientes: los ya enviados no hacen nada. */
const BACK_PREFIX = "back:";
const NO_ANSWER_PREFIX = "noanswer:";
const RETURNED_PREFIX = "returned:";
/** Flujo de activación inicial del domiciliario (consentimiento + verificación GPS). */
const ONBOARD_PREFIX = "onboard:";
/** Los botones de la ficha anterior: los ya enviados tienen que seguir sirviendo. */
const OLD_SEEN_PREFIX = "seen:";
const OLD_DELIVER_PREFIX = "deliver:";

export type OnboardingAction = "accept" | "help" | "check" | "test";

export type CourierButton =
  | { kind: "going"; tripId: number; old: boolean }
  /** `debt`: además de recoger, declara que tendrá que volver. */
  | { kind: "picked"; tripId: number; debt: ReturnDebtReason | null }
  | { kind: "delivered"; tripId: number; place: DeliveryPlace }
  | { kind: "debt_done"; debtId: number }
  | { kind: "back"; tripId: number }
  | { kind: "no_answer"; tripId: number }
  | { kind: "returned"; tripId: number }
  | { kind: "onboarding"; action: OnboardingAction };

/** Qué tocó el motorizado; `null` si el botón no es de su flujo. */
export function parseCourierButton(id: string): CourierButton | null {
  const after = (prefix: string) => Number(id.slice(prefix.length));
  if (id.startsWith(GOING_PREFIX)) return { kind: "going", tripId: after(GOING_PREFIX), old: false };
  if (id.startsWith(OLD_SEEN_PREFIX)) return { kind: "going", tripId: after(OLD_SEEN_PREFIX), old: true };
  if (id.startsWith(PICKED_PREFIX)) return { kind: "picked", tripId: after(PICKED_PREFIX), debt: null };
  if (id.startsWith(PICK_DEBT_PREFIX)) {
    const [reason, tripId] = id.slice(PICK_DEBT_PREFIX.length).split(":");
    if (reason !== "datafono" && reason !== "plata") return null;
    return { kind: "picked", tripId: Number(tripId), debt: reason };
  }
  if (id.startsWith(DEBT_DONE_PREFIX)) return { kind: "debt_done", debtId: after(DEBT_DONE_PREFIX) };
  if (id.startsWith(BACK_PREFIX)) return { kind: "back", tripId: after(BACK_PREFIX) };
  if (id.startsWith(NO_ANSWER_PREFIX)) return { kind: "no_answer", tripId: after(NO_ANSWER_PREFIX) };
  if (id.startsWith(RETURNED_PREFIX)) return { kind: "returned", tripId: after(RETURNED_PREFIX) };
  if (id.startsWith(ONBOARD_PREFIX)) {
    const action = id.slice(ONBOARD_PREFIX.length);
    if (action === "accept" || action === "help" || action === "check" || action === "test") return { kind: "onboarding", action };
    return null;
  }
  if (id.startsWith(OLD_DELIVER_PREFIX)) return { kind: "delivered", tripId: after(OLD_DELIVER_PREFIX), place: "customer" };
  // `done:<lugar>:<finish|return>:<id>`: el «vuelvo» de la lista anterior ya no
  // existe, así que una opción vieja con «vuelvo» solo marca la entrega.
  if (id.startsWith(DONE_PREFIX)) {
    const [place, , tripId] = id.slice(DONE_PREFIX.length).split(":");
    return { kind: "delivered", tripId: Number(tripId), place: place === "gate" ? "gate" : "customer" };
  }
  return null;
}

// WhatsApp: máximo 3 botones, de 20 caracteres.
export const goingButton = (tripId: number) => ({ id: `${GOING_PREFIX}${tripId}`, title: "🛵 Voy en camino" });
export const pickedButton = (tripId: number) => ({ id: `${PICKED_PREFIX}${tripId}`, title: "📦 Recogí" });
export const returnedButton = (tripId: number) => ({ id: `${RETURNED_PREFIX}${tripId}`, title: "Devolví el pedido" });

/** Las tres formas de recoger: lo normal, o recoger y declarar que tendrá que
 *  volver. Las tres cuentan como «Recogí». */
export const pickupButtons = (tripId: number) => [
  pickedButton(tripId),
  { id: `${PICK_DEBT_PREFIX}datafono:${tripId}`, title: "💳 Llevo datáfono" },
  { id: `${PICK_DEBT_PREFIX}plata:${tripId}`, title: "💵 Quedé debiendo" },
];

/** Cómo quedó la entrega. El servicio termina al marcarla: ya no se decide
 *  aquí si vuelve. Mientras espera a un cliente que no contesta, sin esa opción. */
export const deliveryButtons = (tripId: number, { waiting = false } = {}) => [
  { id: `${DONE_PREFIX}customer:finish:${tripId}`, title: "✅ Entregado" },
  { id: `${DONE_PREFIX}gate:finish:${tripId}`, title: "🏢 En portería" },
  ...(waiting ? [] : [{ id: `${NO_ANSWER_PREFIX}${tripId}`, title: "Cliente no contesta" }]),
];

/** Un encargo termina con un solo toque: no hay «Voy en camino», «Recogí» ni
 *  portería. Es el mismo botón de «Entregado», así que se atiende igual. */
export const errandButtons = (tripId: number) => [{ id: `${DONE_PREFIX}customer:finish:${tripId}`, title: "✅ Entregado" }];

export const debtButton = (debtId: number, reason: ReturnDebtReason) => ({ id: `${DEBT_DONE_PREFIX}${debtId}`, title: debtCloseButtonTitle(reason) });

/** Botones de activación inicial del domiciliario (títulos <= 20 caracteres, límite de Meta). */
/** `testNumber` (solo staging, con el simulador): un tercer botón para quedarse como número de prueba en vez de activarse. */
export const onboardingConsentButtons = ({ testNumber = false } = {}) => [
  { id: `${ONBOARD_PREFIX}accept`, title: "✅ Acepto y seguir" },
  { id: `${ONBOARD_PREFIX}help`, title: "🙋 Tengo dudas" },
  ...(testNumber ? [{ id: `${ONBOARD_PREFIX}test`, title: "Solo pruebas" }] : []),
];

export const onboardingCheckButtons = () => [
  { id: `${ONBOARD_PREFIX}check`, title: "✅ Listo, verificar" },
  { id: `${ONBOARD_PREFIX}help`, title: "🙋 Necesito ayuda" },
];

export const onboardingRetryButtons = () => [
  { id: `${ONBOARD_PREFIX}check`, title: "🔄 Volver a probar" },
  { id: `${ONBOARD_PREFIX}help`, title: "🙋 Necesito ayuda" },
];
