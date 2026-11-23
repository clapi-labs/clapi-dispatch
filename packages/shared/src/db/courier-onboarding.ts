import { randomBytes } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "./client";
import { courierProfiles, settings } from "./schema";

/** Versión del aviso de privacidad y uso de ubicación (Ley 1581 de 2012). */
export const GPS_CONSENT_VERSION = "2026-11-v1";

/** Clave en `settings` donde se guarda la referencia al video de activación de domiciliarios. */
export const ONBOARDING_VIDEO_SETTING_KEY = "courier_onboarding_video";

/** Ruta relativa dentro de `MEDIA_DIR` donde vive el MP4 (fuera de las carpetas AAAA-MM-DD que limpia `purgeOldMedia`). */
export const ONBOARDING_VIDEO_RELATIVE_PATH = "onboarding/domiciliarios.mp4";

export type OnboardingVideoSetting = {
  /** ID del video ya subido a Meta Cloud API (se renueva automáticamente antes de vencer a los 30 días). */
  mediaId?: string;
  /** Cuándo se subió `mediaId` a Meta (ISO string). */
  mediaIdUploadedAt?: string;
  /** SHA-256 del archivo local al que corresponde `mediaId`: si cambia el archivo, se vuelve a subir. */
  fileHash?: string;
  /** Opcional: URL HTTPS directa de un MP4 público (si se define, se envía por enlace sin subir archivo). */
  url?: string;
  /** Opcional: texto personalizado que acompaña al video. */
  caption?: string;
};

export type CourierOnboardingState = {
  gpsDeviceId: string | null;
  gpsConsentAt: Date | null;
  gpsConsentVersion: string | null;
  onboardingCompletedAt: Date | null;
};

/** Lee el estado de activación y consentimiento de un motorizado. */
export async function getCourierOnboardingState(courierId: number): Promise<CourierOnboardingState> {
  const [row] = await db
    .select({
      gpsDeviceId: courierProfiles.gpsDeviceId,
      gpsConsentAt: courierProfiles.gpsConsentAt,
      gpsConsentVersion: courierProfiles.gpsConsentVersion,
      onboardingCompletedAt: courierProfiles.onboardingCompletedAt,
    })
    .from(courierProfiles)
    .where(eq(courierProfiles.courierId, courierId))
    .limit(1);
  return (
    row ?? {
      gpsDeviceId: null,
      gpsConsentAt: null,
      gpsConsentVersion: null,
      onboardingCompletedAt: null,
    }
  );
}

/** Genera el identificador de GPS si la moto todavía no tiene uno (una sola vez). */
export async function ensureCourierGpsDeviceId(courierId: number): Promise<string> {
  const generated = `moto-${randomBytes(9).toString("base64url")}`;
  await db.insert(courierProfiles).values({ courierId, gpsDeviceId: generated }).onConflictDoNothing();
  await db
    .update(courierProfiles)
    .set({ gpsDeviceId: generated, updatedAt: new Date() })
    .where(and(eq(courierProfiles.courierId, courierId), isNull(courierProfiles.gpsDeviceId)));
  const [row] = await db
    .select({ id: courierProfiles.gpsDeviceId })
    .from(courierProfiles)
    .where(eq(courierProfiles.courierId, courierId))
    .limit(1);
  return row?.id ?? generated;
}

/**
 * Registra la aceptación de datos/GPS (Ley 1581 de 2012) y garantiza que la
 * moto ya tenga su `gpsDeviceId` listo para configurar Traccar Client.
 */
export async function recordCourierConsent(
  courierId: number,
  waMessageId: string | null,
  now = new Date(),
): Promise<{ gpsDeviceId: string; gpsConsentAt: Date; gpsConsentVersion: string }> {
  const gpsDeviceId = await ensureCourierGpsDeviceId(courierId);
  await db
    .update(courierProfiles)
    .set({
      gpsConsentAt: now,
      gpsConsentVersion: GPS_CONSENT_VERSION,
      gpsConsentWaMessageId: waMessageId,
      updatedAt: now,
    })
    .where(and(eq(courierProfiles.courierId, courierId), isNull(courierProfiles.gpsConsentAt)));
  const state = await getCourierOnboardingState(courierId);
  return {
    gpsDeviceId,
    gpsConsentAt: state.gpsConsentAt ?? now,
    gpsConsentVersion: state.gpsConsentVersion ?? GPS_CONSENT_VERSION,
  };
}

/** Marca la activación inicial como completada tras comprobar señal GPS en vivo. */
export async function completeCourierOnboarding(courierId: number, now = new Date()): Promise<void> {
  await db
    .insert(courierProfiles)
    .values({ courierId, onboardingCompletedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: courierProfiles.courierId,
      set: { onboardingCompletedAt: now, updatedAt: now },
    });
}

export async function getOnboardingVideoSetting(): Promise<OnboardingVideoSetting> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, ONBOARDING_VIDEO_SETTING_KEY))
    .limit(1);
  if (!row || typeof row.value !== "object" || row.value === null) return {};
  return row.value as OnboardingVideoSetting;
}

export async function saveOnboardingVideoSetting(value: OnboardingVideoSetting): Promise<void> {
  await db
    .insert(settings)
    .values({ key: ONBOARDING_VIDEO_SETTING_KEY, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value },
    });
}
