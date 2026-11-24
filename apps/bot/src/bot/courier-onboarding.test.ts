import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import {
  db,
  getCourierOnboardingState,
  getOnboardingVideoSetting,
  GPS_CONSENT_VERSION,
  saveOnboardingVideoSetting,
  schema,
} from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  buttonFrom,
  classified,
  classifier,
  getConversation,
  getCourier,
  installMocks,
  minutesAgo,
  outbox,
  plain,
  resetMocks,
  restoreMocks,
  sentTo,
  textFrom,
  uploadedMedia,
  whatsapp,
  world,
  type World,
} from "@/test-support/bot-env";
import type { IncomingMessage } from "@/services/whatsapp/types";

/**
 * Flujo de activación inicial del domiciliario por WhatsApp:
 * primer «hola» → bienvenida y autorización Ley 1581 → video guía (si está
 * cargado) + datos de Traccar Client → verificación en vivo de señal GPS.
 */

type CourierMod = typeof import("./courier");
type OnboardingMod = typeof import("./courier-onboarding");
let courierMod: CourierMod;
let onboarding: OnboardingMod;

before(async () => {
  await installMocks();
  onboarding = await import("./courier-onboarding");
  if (!integrationSkip) courierMod = await import("./courier");
});

describe("courier-onboarding: textos y verificación pura", () => {
  it("con el dominio del portal, el consentimiento es corto y enlaza la política completa", () => {
    const text = onboarding.consentPromptText("Carlos Pérez", "https://dispatch.clapi.solutions/tratamiento-de-datos");
    assert.ok(text.length <= 1024, `muy largo: ${text.length}`);
    assert.match(text, /Carlos/);
    assert.match(text, /Ley 1581/);
    assert.ok(text.includes("https://dispatch.clapi.solutions/tratamiento-de-datos"));
    assert.doesNotMatch(text, /24 horas/);
  });

  it("la política se enlaza en el dominio del portal; sin él, no hay enlace", () => {
    const saved = process.env.PORTAL_HOST;
    try {
      process.env.PORTAL_HOST = "https://dispatch.clapi.solutions/";
      assert.equal(onboarding.privacyPolicyUrl(), "https://dispatch.clapi.solutions/tratamiento-de-datos");
      delete process.env.PORTAL_HOST;
      assert.equal(onboarding.privacyPolicyUrl(), "");
    } finally {
      if (saved === undefined) delete process.env.PORTAL_HOST;
      else process.env.PORTAL_HOST = saved;
    }
  });

  it("sin el dominio del portal, el aviso de consentimiento va completo, cabe en un mensaje interactivo de WhatsApp (<= 1024) y menciona Ley 1581", () => {
    const text = onboarding.consentPromptText("Carlos Pérez", "");
    assert.ok(text.length <= 1024, `muy largo: ${text.length}`);
    assert.match(text, /Carlos/);
    assert.match(text, /Ley 1581/);
    assert.match(text, /24 horas/);
  });

  it("las instrucciones traen links de Android/iPhone, deviceId y URL de GPS", () => {
    const text = onboarding.setupInstructionsText("moto-abc123", "https://bot.dispatch.clapi.solutions/api/gps");
    assert.ok(text.includes(onboarding.TRACCAR_ANDROID_URL));
    assert.ok(text.includes(onboarding.TRACCAR_IOS_URL));
    assert.ok(text.includes("moto-abc123"));
    assert.ok(text.includes("https://bot.dispatch.clapi.solutions/api/gps"));
  });

  it("si falta BOT_HOST, igual entrega el deviceId sin imprimir una URL rota", () => {
    const text = onboarding.setupInstructionsText("moto-abc123", "");
    assert.ok(text.includes("moto-abc123"));
    assert.ok(!text.includes("https:///api/gps"));
  });

  it("los mensajes de verificación, reintento y cierre caben en WhatsApp", () => {
    assert.ok(onboarding.verifyPromptText().length <= 1024);
    assert.ok(onboarding.retryGpsText("moto-abc").length <= 1024);
    assert.ok(onboarding.retryGpsText("moto-abc").includes("moto-abc"));
    assert.match(onboarding.onboardingDoneText("Juan Castro"), /Juan/);
  });

  it("isGpsConnectedForOnboarding acepta señal reciente dentro de 5 min aunque locationMoving sea null", () => {
    const now = Date.now();
    assert.equal(
      onboarding.isGpsConnectedForOnboarding({ lat: 3.45, lng: -76.53, locationUpdatedAt: new Date(now - 90_000), locationMoving: null }, now),
      true,
    );
    assert.equal(
      onboarding.isGpsConnectedForOnboarding({ lat: 3.45, lng: -76.53, locationUpdatedAt: new Date(now - 10 * 60_000), locationMoving: null }, now),
      false,
    );
    assert.equal(
      onboarding.isGpsConnectedForOnboarding({ lat: null, lng: null, locationUpdatedAt: null, locationMoving: null }, now),
      false,
    );
  });
});

let tempDir = "";

describe("courier-onboarding: flujo completo por WhatsApp (Postgres)", { skip: integrationSkip }, () => {
  beforeEach(async () => {
    await resetDatabase();
    resetMocks();
    delete process.env.SIMULATOR_ENABLED;
    delete process.env.COURIER_ONBOARDING_VIDEO_URL;
    delete process.env.COURIER_ONBOARDING_VIDEO_PATH;
    process.env.BOT_HOST = "bot.dispatch.clapi.solutions";
    tempDir = mkdtempSync(path.join(tmpdir(), "dispatch-onboard-"));
    process.env.MEDIA_DIR = tempDir;
  });

  after(async () => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    restoreMocks();
    await closeTestDatabase();
  });

  async function act(w: World, message: IncomingMessage) {
    const found = await courierMod.findCourier(w.courier.phone);
    assert.ok(found);
    await courierMod.handleCourier(found, await getConversation(w.courierConversation.id), message);
  }
  const write = (w: World, text: string) => act(w, textFrom(w.courier.phone, text));
  const tap = (w: World, id: string) => act(w, buttonFrom(w.courier.phone, id));

  it("flujo feliz completo: primer «hola» → aceptar Ley 1581 → video + Traccar → sin señal falla → con GPS activa y luego «hola» conecta normal", async () => {
    const videoFile = path.join(tempDir, "onboarding", "domiciliarios.mp4");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(videoFile), { recursive: true });
    writeFileSync(videoFile, Buffer.from("fake-mp4-bytes-v1"));

    const w = await world({ courier: { status: "offline" } });

    // 1. Primer «hola»: pide autorización de datos y NO conecta ni llama a OpenAI.
    await write(w, "hola");
    assert.equal(classified.length, 0, "no gasta OpenAI en el primer saludo");
    assert.equal((await getCourier(w.courier.id)).status, "offline", "no queda disponible antes de configurar GPS");
    const step1 = sentTo(w.courier.phone);
    assert.equal(step1.length, 1);
    assert.match(plain(step1[0].text), /Ley 1581/);
    assert.deepEqual(step1[0].buttons.map((b) => b.id), ["onboard:accept", "onboard:help"]);

    // 2. Toca «Acepto y seguir»: guarda consentimiento + sube y envía video + envía datos Traccar + botón verificar.
    outbox.length = 0;
    await tap(w, "onboard:accept");
    const state = await getCourierOnboardingState(w.courier.id);
    assert.ok(state.gpsConsentAt, "guardó fecha de consentimiento");
    assert.equal(state.gpsConsentVersion, GPS_CONSENT_VERSION);
    assert.ok(state.gpsDeviceId?.startsWith("moto-"), "generó gpsDeviceId");
    assert.equal(state.onboardingCompletedAt, null, "aún no termina sin GPS");
    assert.equal(uploadedMedia.length, 1, "subió el MP4 a Meta una vez");

    const step2 = sentTo(w.courier.phone);
    assert.equal(step2.length, 3, "video + instrucciones Traccar + botón de verificación");
    assert.equal(step2[0].video?.id, uploadedMedia[0].id);
    assert.ok(step2[1].text.includes(state.gpsDeviceId!));
    assert.ok(step2[1].text.includes("https://bot.dispatch.clapi.solutions/api/gps"));
    assert.deepEqual(step2[2].buttons.map((b) => b.id), ["onboard:check", "onboard:help"]);

    // 3. Toca «Listo, verificar» ANTES de prender Traccar: le avisa y sigue offline.
    outbox.length = 0;
    await tap(w, "onboard:check");
    assert.equal((await getCourier(w.courier.id)).status, "offline");
    assert.equal((await getCourierOnboardingState(w.courier.id)).onboardingCompletedAt, null);
    const step3 = sentTo(w.courier.phone);
    assert.equal(step3.length, 1);
    assert.match(plain(step3[0].text), /Todavía no recibimos señal GPS/);
    assert.ok(step3[0].text.includes(state.gpsDeviceId!));
    assert.deepEqual(step3[0].buttons.map((b) => b.id), ["onboard:check", "onboard:help"]);

    // 4. Llega señal GPS real de su celular y vuelve a tocar «Volver a probar».
    await db
      .update(schema.couriers)
      .set({ lat: 3.45, lng: -76.53, locationUpdatedAt: minutesAgo(1), locationMoving: null })
      .where(eq(schema.couriers.id, w.courier.id));

    outbox.length = 0;
    await tap(w, "onboard:check");
    assert.equal((await getCourier(w.courier.id)).status, "available", "quedó conectado y activo");
    assert.ok((await getCourierOnboardingState(w.courier.id)).onboardingCompletedAt, "marcó activación completada");
    const step4 = sentTo(w.courier.phone);
    assert.equal(step4.length, 1);
    assert.match(plain(step4[0].text), /Ya recibimos tu ubicación en vivo y tu cuenta quedó activa/);

    // 5. Al día siguiente se desconecta y vuelve a escribir «hola»: conecta directo sin repetir onboarding.
    await db
      .update(schema.couriers)
      .set({ status: "offline", locationUpdatedAt: null })
      .where(eq(schema.couriers.id, w.courier.id));
    outbox.length = 0;
    classifier.next({ tipo: "otro" });
    await write(w, "hola");
    assert.equal((await getCourier(w.courier.id)).status, "available");
    assert.match(plain(sentTo(w.courier.phone)[0].text), /^👋 Pedro, quedaste conectado\./);
  });

  it("reutiliza el media_id cacheado del video para el segundo domiciliario y solo lo resube si cambia el MP4", async () => {
    const videoFile = path.join(tempDir, "onboarding", "domiciliarios.mp4");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(videoFile), { recursive: true });
    writeFileSync(videoFile, Buffer.from("video-v1"));

    const a = await world({ courier: { status: "offline" } });
    const b = await world({ courier: { status: "offline" } });
    const c = await world({ courier: { status: "offline" } });

    await tap(a, "onboard:accept");
    assert.equal(uploadedMedia.length, 1);
    const firstId = uploadedMedia[0].id;

    // Segundo domiciliario: mismo archivo → reutiliza media_id sin subir de nuevo.
    await tap(b, "onboard:accept");
    assert.equal(uploadedMedia.length, 1);
    assert.equal(sentTo(b.courier.phone)[0].video?.id, firstId);

    // Se reemplaza el archivo MP4: detecta nuevo SHA-256 y vuelve a subir.
    writeFileSync(videoFile, Buffer.from("video-v2-nuevo"));
    await tap(c, "onboard:accept");
    assert.equal(uploadedMedia.length, 2);
    assert.notEqual(uploadedMedia[1].id, firstId);
    assert.equal((await getOnboardingVideoSetting()).mediaId, uploadedMedia[1].id);
  });

  it("si todavía no hay video cargado en disco ni URL, igual envía los datos de Traccar y el botón sin fallar", async () => {
    const w = await world({ courier: { status: "offline" } });
    await tap(w, "onboard:accept");
    const sent = sentTo(w.courier.phone);
    assert.equal(sent.length, 2, "solo instrucciones Traccar + botón de verificación");
    assert.equal(sent[0].video, undefined);
    assert.ok(sent[0].text.includes("Traccar Client"));
    assert.deepEqual(sent[1].buttons.map((b) => b.id), ["onboard:check", "onboard:help"]);
  });

  it("si hay URL directa de video en settings, la envía como link sin subir archivo", async () => {
    await saveOnboardingVideoSetting({ url: "https://cdn.clapi.test/domiciliarios.mp4" });
    const w = await world({ courier: { status: "offline" } });
    await tap(w, "onboard:accept");
    assert.equal(uploadedMedia.length, 0);
    assert.equal(sentTo(w.courier.phone)[0].video?.link, "https://cdn.clapi.test/domiciliarios.mp4");
  });

  it("si falla la subida de video a Meta, igual envía las instrucciones de Traccar", async () => {
    const videoFile = path.join(tempDir, "onboarding", "domiciliarios.mp4");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(videoFile), { recursive: true });
    writeFileSync(videoFile, Buffer.from("video-v1"));
    whatsapp.failUploads(true);

    const w = await world({ courier: { status: "offline" } });
    await tap(w, "onboard:accept");
    const sent = sentTo(w.courier.phone);
    assert.equal(sent.length, 2);
    assert.ok(sent[0].text.includes("Traccar Client"));
  });

  it("«Tengo dudas / Necesito ayuda» escala a la central, y si luego configura GPS y toca verificar, se destraba solo", async () => {
    const w = await world({ courier: { status: "offline" } });
    await tap(w, "onboard:accept");
    outbox.length = 0;

    await tap(w, "onboard:help");
    const paused = await getConversation(w.courierConversation.id);
    assert.equal(paused.botPaused, true);
    assert.match(paused.escalationReason ?? "", /Activación de Pedro Gómez/);
    assert.match(plain(sentTo(w.courier.phone)[0].text), /avisamos a la central/);

    // Logra conectar GPS y toca «Listo, verificar».
    await db
      .update(schema.couriers)
      .set({ lat: 3.45, lng: -76.53, locationUpdatedAt: new Date() })
      .where(eq(schema.couriers.id, w.courier.id));
    outbox.length = 0;
    await tap(w, "onboard:check");

    assert.equal((await getCourier(w.courier.id)).status, "available");
    const resumed = await getConversation(w.courierConversation.id);
    assert.equal(resumed.botPaused, false);
    assert.equal(resumed.escalationReason, null);
  });

  it("si ya aceptó y escribe «listo» cuando el GPS ya está enviando, completa la activación aunque no tocó el botón", async () => {
    const w = await world({ courier: { status: "offline" } });
    await tap(w, "onboard:accept");
    await db
      .update(schema.couriers)
      .set({ lat: 3.45, lng: -76.53, locationUpdatedAt: new Date() })
      .where(eq(schema.couriers.id, w.courier.id));

    outbox.length = 0;
    await write(w, "listo ya quedó");
    assert.equal((await getCourier(w.courier.id)).status, "available");
    assert.ok((await getCourierOnboardingState(w.courier.id)).onboardingCompletedAt);
    assert.match(plain(sentTo(w.courier.phone)[0].text), /tu cuenta quedó activa/);
  });
  it("en staging, un domiciliario real nuevo también pasa por la activación, y puede quedarse como número de prueba", async () => {
    process.env.SIMULATOR_ENABLED = "1";
    try {
      const real = await world({ courier: { status: "offline" } });
      await write(real, "hola");
      assert.equal((await getCourier(real.courier.id)).status, "offline", "no se conecta antes de autorizar");
      const prompt = sentTo(real.courier.phone);
      assert.equal(prompt.length, 1);
      assert.match(plain(prompt[0].text), /Ley 1581/);
      assert.deepEqual(prompt[0].buttons.map((b) => b.id), ["onboard:accept", "onboard:help", "onboard:test"]);

      // «Número de prueba»: queda conectado como antes de la activación, sin consentimiento ni GPS.
      outbox.length = 0;
      await tap(real, "onboard:test");
      assert.equal((await getCourier(real.courier.id)).status, "available");
      const state = await getCourierOnboardingState(real.courier.id);
      assert.equal(state.gpsConsentAt, null);
      assert.ok(state.onboardingCompletedAt);
      assert.match(plain(sentTo(real.courier.phone)[0].text), /número de prueba/);

      // Al día siguiente escribe «hola» y conecta directo, sin volver a la activación.
      await db.update(schema.couriers).set({ status: "offline" }).where(eq(schema.couriers.id, real.courier.id));
      outbox.length = 0;
      classifier.next({ tipo: "otro" });
      await write(real, "hola");
      assert.equal((await getCourier(real.courier.id)).status, "available");
      assert.doesNotMatch(plain(sentTo(real.courier.phone)[0].text), /Ley 1581/);
    } finally {
      delete process.env.SIMULATOR_ENABLED;
    }
  });

  it("en producción no existe «Número de prueba»: el botón no hace nada", async () => {
    const w = await world({ courier: { status: "offline" } });
    await write(w, "hola");
    assert.deepEqual(sentTo(w.courier.phone)[0].buttons.map((b) => b.id), ["onboard:accept", "onboard:help"]);
    outbox.length = 0;
    await tap(w, "onboard:test");
    assert.equal((await getCourier(w.courier.id)).status, "offline");
    assert.equal((await getCourierOnboardingState(w.courier.id)).onboardingCompletedAt, null);
    assert.equal(sentTo(w.courier.phone).length, 0);
  });
});
