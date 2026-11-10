"use client";

/**
 * Alertas al celular, del lado del navegador (docs/INTERVENCION-MANUAL.md,
 * «Alertas al celular»): instalar el service worker, activar o apagar las
 * alertas en este equipo y saber en qué estado están.
 */

/** El portal abierto desde el ícono de la pantalla de inicio, no desde el navegador. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export type Platform = "ios" | "android" | "other";

export function platform(): Platform {
  const ua = navigator.userAgent;
  // El iPad se presenta como Mac: se distingue por la pantalla táctil.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

/** La versión de iOS (16.4 → 16.4), o null si no se sabe. */
export function iosVersion(): number | null {
  const m = navigator.userAgent.match(/OS (\d+)_(\d+)/) ?? navigator.userAgent.match(/Version\/(\d+)\.(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export type PushStatus =
  /** Activas en este equipo. */
  | "on"
  /** Se pueden activar con un toque. */
  | "off"
  /** Bloqueadas en los ajustes del celular o del navegador. */
  | "denied"
  /** iPhone: hay que agregar el portal a la pantalla de inicio y abrirlo desde ahí. */
  | "needs-install"
  /** iPhone con iOS anterior a 16.4: no se pueden. */
  | "ios-too-old"
  /** Este navegador no tiene notificaciones web. */
  | "unsupported";

let registration: Promise<ServiceWorkerRegistration> | null = null;

/** Registra el service worker (una vez por carga). */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> | null {
  if (!("serviceWorker" in navigator)) return null;
  registration ??= navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return registration;
}

export async function getPushStatus(): Promise<PushStatus> {
  if (platform() === "ios") {
    const version = iosVersion();
    if (version !== null && version < 16.04) return "ios-too-old";
    // En Safari sin instalar, iOS no ofrece notificaciones.
    if (!isStandalone() || !supported()) return "needs-install";
  }
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let publicKey: Promise<string | null> | null = null;

/** La llave del servidor. Se pide antes del toque: en iPhone, suscribirse
 *  tiene que pasar dentro del toque, sin esperas de red antes. */
export function loadPublicKey(): Promise<string | null> {
  publicKey ??= fetch("/api/push", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => (typeof body?.publicKey === "string" ? body.publicKey : null))
    .catch(() => null)
    .then((key) => {
      if (!key) publicKey = null; // que el próximo intento vuelva a pedirla
      return key;
    });
  return publicKey;
}

async function save(sub: PushSubscription): Promise<boolean> {
  const res = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  }).catch(() => null);
  return !!res?.ok;
}

/** Quien apagó las alertas en este equipo no las vuelve a tener solas al abrir el portal. */
const OFF_KEY = "alertas-celular-apagadas";

/**
 * Activa las alertas en este equipo. Va directo en el toque del botón: el
 * navegador pide el permiso ahí mismo. Devuelve el estado en que quedó.
 */
export async function enablePush(): Promise<PushStatus> {
  const [reg, key] = await Promise.all([registerServiceWorker(), loadPublicKey()]);
  if (!reg || !key) throw new Error("No se pudo preparar el portal para las alertas. Revisa la conexión.");
  let sub = await reg.pushManager.getSubscription();
  if (sub && toBase64Url(sub.options.applicationServerKey) !== key) {
    await sub.unsubscribe();
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
  } catch (error) {
    if (Notification.permission === "denied") return "denied";
    throw error;
  }
  if (!(await save(sub))) throw new Error("El portal no pudo guardar las alertas. Intenta de nuevo.");
  localStorage.removeItem(OFF_KEY);
  return "on";
}

/** Apaga las alertas solo en este equipo. */
export async function disablePush(): Promise<void> {
  localStorage.setItem(OFF_KEY, "1");
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/push", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => null);
  await sub.unsubscribe().catch(() => false);
}

/**
 * Al abrir el portal: si este equipo tenía las alertas activas, se vuelven a
 * guardar con la sesión de ahora (después de iniciar sesión otra vez, o si el
 * servidor cambió de llave). Así no hay que activarlas de nuevo a mano.
 */
export async function syncPush(): Promise<void> {
  if (!supported() || Notification.permission !== "granted" || localStorage.getItem(OFF_KEY)) return;
  const [reg, key] = await Promise.all([registerServiceWorker(), loadPublicKey()]);
  if (!reg || !key) return;
  const sub = await reg.pushManager.getSubscription();
  if (sub && toBase64Url(sub.options.applicationServerKey) === key) {
    await save(sub);
    return;
  }
  // Sin suscripción o con la llave vieja, y el permiso ya dado: se rehace.
  // Si el navegador exige un toque para esto (iPhone), queda en "off" y el
  // portal lo muestra.
  try {
    await sub?.unsubscribe();
    const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
    await save(fresh);
  } catch {}
}

/** Manda un aviso de prueba a este equipo. */
export async function sendTestPush(): Promise<boolean> {
  const res = await fetch("/api/push/test", { method: "POST" }).catch(() => null);
  const body = await res?.json().catch(() => null);
  return !!body && body.sent > 0;
}

// ---------------------------------------------------------------------------
// Instalar el portal como app
// ---------------------------------------------------------------------------

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let installPrompt: InstallPrompt | null = null;
const installListeners = new Set<() => void>();

/** Android (Chrome) ofrece instalar al cargar la página: se guarda la oferta
 *  para el botón «Instalar» de la pantalla de alertas. */
export function captureInstallPrompt(): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    installListeners.forEach((fn) => fn());
  };
  const onInstalled = () => {
    installPrompt = null;
    installListeners.forEach((fn) => fn());
  };
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

export function canPromptInstall(): boolean {
  return installPrompt !== null;
}

export function onInstallChange(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

/** Abre el diálogo de instalar de Android. `true` si lo instaló. */
export async function promptInstall(): Promise<boolean> {
  const prompt = installPrompt;
  if (!prompt) return false;
  installPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  installListeners.forEach((fn) => fn());
  return outcome === "accepted";
}
