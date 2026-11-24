import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";

import { hasSignal, traccarConfigMessage } from "@dispatch/shared";
import {
  completeCourierOnboarding,
  db,
  ensureCourierGpsDeviceId,
  getCourierOnboardingState,
  getOnboardingVideoSetting,
  ONBOARDING_VIDEO_RELATIVE_PATH,
  recordCourierConsent,
  saveOnboardingVideoSetting,
  schema,
  type CourierOnboardingState,
} from "@dispatch/shared/db";
import { mediaConfig } from "@dispatch/shared/media";

import {
  onboardingCheckButtons,
  onboardingConsentButtons,
  onboardingRetryButtons,
  type OnboardingAction,
} from "@/bot/courier-buttons";
import { say, sayVideo } from "@/bot/messaging";
import { updateConversation, type Conversation } from "@/db/queries/conversation";
import { env } from "@/env";
import { uploadMedia } from "@/services/whatsapp/client";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * Activación inicial del domiciliario por WhatsApp:
 *
 * 1. Al escribir su primer «hola» (desconectado y sin activación previa), el bot
 *    le da la bienvenida y le pide autorización expresa para tratar sus datos y
 *    su ubicación GPS durante el turno (Ley 1581 de 2012).
 * 2. Al tocar «✅ Acepto y seguir», se registra la prueba del consentimiento en
 *    `courier_profiles`, se envía el video guía (si ya está cargado en disco o
 *    URL), se mandan los enlaces y credenciales de Traccar Client y el botón
 *    «✅ Listo, verificar».
 * 3. Al tocar «✅ Listo, verificar», el bot comprueba en vivo si ya llegó señal
 *    GPS de ese celular. Si llegó, activa al domiciliario; si no, le muestra una
 *    guía corta de 3 pasos para reintentar o pedir ayuda a la central.
 */

type Courier = typeof schema.couriers.$inferSelect;

/** Ventana de verificación tras configurar Traccar: 5 minutos. El primer reporte
 *  de Traccar llega sin indicador de movimiento (`locationMoving = null`), así
 *  que dar 5 minutos evita falsos negativos mientras el domiciliario vuelve a WhatsApp. */
export const ONBOARDING_GPS_WINDOW_MS = 5 * 60_000;

/** Los `media_id` de Meta vencen a los 30 días: renovamos a los 25 días. */
export const MEDIA_ID_MAX_AGE_MS = 25 * 24 * 60 * 60_000;

export const TRACCAR_ANDROID_URL = "https://play.google.com/store/apps/details?id=org.traccar.client";
export const TRACCAR_IOS_URL = "https://apps.apple.com/app/traccar-client/id843156974";
export const DEFAULT_VIDEO_CAPTION = "🎥 Mira este video corto: así funciona el sistema y así configuras tu ubicación paso a paso.";

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "compañero";
}

/** Mensaje 1: bienvenida + autorización de datos y GPS (Ley 1581 de 2012). */
export function consentPromptText(courierName: string): string {
  return [
    `👋 ¡Hola, ${firstName(courierName)}! Bienvenido al sistema de domicilios de Express Cali 🛵`,
    "",
    "Antes de activar tu cuenta, necesitamos tu autorización para el tratamiento de datos (Ley 1581 de 2012):",
    "• Usamos tu nombre, teléfono y datos de ficha para coordinar los servicios.",
    "• Usamos tu ubicación GPS únicamente mientras tienes la app encendida en turno, para asignarte el pedido más cercano y confirmar llegadas.",
    "• Solo guardamos tu última posición y se borra automáticamente a las 24 horas. Al terminar tu turno apagas la app.",
    "• Puedes consultar, actualizar o revocar esta autorización escribiendo a la administración.",
    "",
    "¿Autorizas el uso de tus datos y ubicación para activar tu cuenta?",
  ].join("\n");
}

/** Datos de Traccar Client + enlaces oficiales de descarga. */
export function setupInstructionsText(deviceId: string, serverUrl: string): string {
  const links = [
    "📲 Descarga la app *Traccar Client*:",
    `Android: ${TRACCAR_ANDROID_URL}`,
    `iPhone: ${TRACCAR_IOS_URL}`,
  ].join("\n");

  if (!serverUrl) {
    return [
      links,
      "",
      "Tu identificador del dispositivo es:",
      deviceId,
      "",
      "Pídele a la central la URL del servidor de GPS para completar la configuración.",
    ].join("\n");
  }

  return `${links}\n\n${traccarConfigMessage(deviceId, serverUrl)}`;
}

export function verifyPromptText(): string {
  return "Cuando ya hayas guardado estos datos y encendido el interruptor de Traccar Client, toca el botón de abajo para verificar tu conexión 👇";
}

export function retryGpsText(deviceId: string): string {
  return [
    "⚠️ Todavía no recibimos señal GPS de tu celular. Revisa estos 3 pasos en Traccar Client:",
    "",
    "1. Que el interruptor de estado esté encendido (ON).",
    `2. Que el Identificador (${deviceId}) y la URL no tengan espacios de más.`,
    "3. Que la app tenga permiso de Ubicación «Permitir todo el tiempo» y Batería «Sin restricciones».",
    "",
    "Espera 15 segundos con la app abierta y vuelve a tocar el botón 👇",
  ].join("\n");
}

export function onboardingDoneText(courierName: string): string {
  return [
    `✅ ¡Excelente, ${firstName(courierName)}! Ya recibimos tu ubicación en vivo y tu cuenta quedó activa 🛵`,
    "",
    "Te avisaremos por aquí apenas tengas un servicio. Al terminar tu turno apaga Traccar Client y escribe «desactivado».",
  ].join("\n");
}

/** ¿Ya llegó una señal GPS válida o reciente para dar por configurada la app? */
export function isGpsConnectedForOnboarding(
  courier: Pick<Courier, "lat" | "lng" | "locationUpdatedAt" | "locationMoving">,
  now: Date | number = Date.now(),
): boolean {
  if (hasSignal(courier, now)) return true;
  if (courier.lat == null || courier.lng == null || !courier.locationUpdatedAt) return false;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const elapsed = nowMs - courier.locationUpdatedAt.getTime();
  return elapsed >= -60_000 && elapsed <= ONBOARDING_GPS_WINDOW_MS;
}

/** ¿Esta moto real todavía debe pasar por el flujo de activación inicial? */
export function needsOnboarding(
  courier: Pick<Courier, "simulated" | "locationUpdatedAt">,
  state: CourierOnboardingState,
): boolean {
  if (courier.simulated) return false;
  if (state.onboardingCompletedAt) return false;
  // Si ya dio consentimiento pero no completó, sigue en activación.
  // Si nunca dio consentimiento y nunca reportó GPS, es su primera vez.
  return state.gpsConsentAt !== null || courier.locationUpdatedAt === null;
}

function gpsServerUrl(): string {
  return env.botHost ? `https://${env.botHost}/api/gps` : "";
}

function onboardingVideoFilePath(): string {
  return process.env.COURIER_ONBOARDING_VIDEO_PATH?.trim() || path.join(mediaConfig().dir, ONBOARDING_VIDEO_RELATIVE_PATH);
}

/**
 * Envía el video de bienvenida si está configurado (por URL directa o archivo
 * MP4 en `/data/media/onboarding/domiciliarios.mp4`, subiéndolo una sola vez a
 * Meta y cacheando su `media_id` en `settings`). Si todavía no se ha cargado
 * ningún video, devuelve `false` sin interrumpir el resto del flujo.
 */
export async function sendOnboardingVideo(conversationId: number, phone: string, now = new Date()): Promise<boolean> {
  const setting = await getOnboardingVideoSetting();
  const caption = setting.caption?.trim() || DEFAULT_VIDEO_CAPTION;

  const directUrl = process.env.COURIER_ONBOARDING_VIDEO_URL?.trim() || setting.url?.trim();
  if (directUrl) {
    const res = await sayVideo(conversationId, phone, { link: directUrl }, caption);
    return res.ok;
  }

  const filePath = onboardingVideoFilePath();
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    return false;
  }
  if (bytes.length === 0) return false;

  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const uploadedAtMs = setting.mediaIdUploadedAt ? Date.parse(setting.mediaIdUploadedAt) : NaN;
  const freshCache =
    Boolean(setting.mediaId) &&
    setting.fileHash === fileHash &&
    Number.isFinite(uploadedAtMs) &&
    now.getTime() - uploadedAtMs < MEDIA_ID_MAX_AGE_MS;

  if (freshCache && setting.mediaId) {
    const sent = await sayVideo(conversationId, phone, { id: setting.mediaId }, caption);
    if (sent.ok) return true;
    // Si Meta rechazó el media_id (p. ej. expirado), subimos una vez más.
    if (sent.reason !== "http_error") return false;
  }

  const mediaId = await uploadMedia(bytes, "video/mp4", "domiciliarios.mp4");
  if (!mediaId) return false;
  await saveOnboardingVideoSetting({
    ...setting,
    mediaId,
    mediaIdUploadedAt: now.toISOString(),
    fileHash,
  });
  const sent = await sayVideo(conversationId, phone, { id: mediaId }, caption);
  return sent.ok;
}

/** Finaliza la activación, conecta a la moto si estaba offline y libera el chat si había pedido ayuda. */
async function finishOnboarding(courier: Courier, conversation: Conversation, phone: string, now = new Date()) {
  await completeCourierOnboarding(courier.id, now);
  if (courier.status === "offline") {
    await db.update(schema.couriers).set({ status: "available" }).where(eq(schema.couriers.id, courier.id));
  }
  if (conversation.botPaused && conversation.escalationReason?.startsWith("Activación de ")) {
    await updateConversation(conversation.id, { botPaused: false, escalationReason: null });
  }
  await say(conversation.id, phone, onboardingDoneText(courier.name));
}

/** Atiende los botones `onboard:accept`, `onboard:check` y `onboard:help`. */
export async function handleOnboardingButton(
  courier: Courier,
  conversation: Conversation,
  message: IncomingMessage,
  action: OnboardingAction,
): Promise<void> {
  const state = await getCourierOnboardingState(courier.id);

  if (action === "help") {
    await updateConversation(conversation.id, {
      botPaused: true,
      escalationReason: `Activación de ${courier.name}: pidió ayuda para configurar su cuenta o GPS.`,
    });
    await say(conversation.id, message.phone, "Listo 🙏 Ya le avisamos a la central para que te ayude a configurar tu cuenta.");
    return;
  }

  if (action === "accept") {
    if (state.onboardingCompletedAt) {
      await say(conversation.id, message.phone, "Tu cuenta ya está activa y configurada 👍");
      return;
    }
    const { gpsDeviceId } = await recordCourierConsent(courier.id, message.waMessageId);
    await sendOnboardingVideo(conversation.id, message.phone);
    await say(conversation.id, message.phone, setupInstructionsText(gpsDeviceId, gpsServerUrl()));
    await say(conversation.id, message.phone, verifyPromptText(), { buttons: onboardingCheckButtons() });
    return;
  }

  // action === "check"
  if (state.onboardingCompletedAt) {
    await say(conversation.id, message.phone, "Tu cuenta ya está activa y conectada 👍");
    return;
  }

  const [fresh] = await db.select().from(schema.couriers).where(eq(schema.couriers.id, courier.id)).limit(1);
  if (!fresh) return;

  if (!state.gpsConsentAt) {
    await say(conversation.id, message.phone, consentPromptText(fresh.name), { buttons: onboardingConsentButtons() });
    return;
  }

  if (isGpsConnectedForOnboarding(fresh)) {
    await finishOnboarding(fresh, conversation, message.phone);
    return;
  }

  const deviceId = state.gpsDeviceId ?? (await ensureCourierGpsDeviceId(fresh.id));
  await say(conversation.id, message.phone, retryGpsText(deviceId), { buttons: onboardingRetryButtons() });
}

/**
 * Intercepta el primer mensaje (o mensajes durante la activación) de un
 * domiciliario real desconectado que todavía no ha completado su configuración.
 * Devuelve `true` si atendió el mensaje (y `courier.ts` no debe seguir).
 */
export async function handleOnboardingMessage(
  courier: Courier,
  conversation: Conversation,
  message: IncomingMessage,
): Promise<boolean> {
  const state = await getCourierOnboardingState(courier.id);
  if (!needsOnboarding(courier, state)) return false;

  if (!state.gpsConsentAt) {
    await say(conversation.id, message.phone, consentPromptText(courier.name), { buttons: onboardingConsentButtons() });
    return true;
  }

  // Ya aceptó el consentimiento y está configurando Traccar.
  if (isGpsConnectedForOnboarding(courier)) {
    await finishOnboarding(courier, conversation, message.phone);
    return true;
  }

  const deviceId = state.gpsDeviceId ?? (await ensureCourierGpsDeviceId(courier.id));
  const text = message.kind === "text" ? message.text.toLowerCase() : "";
  if (/\b(video|datos|id|url|traccar|enlace|link)\b/.test(text)) {
    await sendOnboardingVideo(conversation.id, message.phone);
    await say(conversation.id, message.phone, setupInstructionsText(deviceId, gpsServerUrl()));
  }
  await say(conversation.id, message.phone, verifyPromptText(), { buttons: onboardingCheckButtons() });
  return true;
}
