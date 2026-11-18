// Service worker del portal: recibe las alertas al celular y, al tocarlas,
// abre el portal donde está lo que avisan (docs/INTERVENCION-MANUAL.md,
// «Alertas al celular»). No guarda nada en caché: el portal siempre se ve en
// vivo.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Cómo se ve y se siente cada nivel (PushMessage.severity en @dispatch/shared):
// naranja pide atención; rojo es una emergencia y no se va hasta que la toquen.
const LEVELS = {
  attention: { icon: "/icons/alert-orange-192.png", vibrate: [200, 100, 200], requireInteraction: false },
  critical: { icon: "/icons/alert-red-192.png", vibrate: [350, 120, 350, 120, 450], requireInteraction: true },
};

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Clapi";
  const level = LEVELS[data.severity] || LEVELS.attention;
  // Siempre se muestra: iPhone retira el permiso si un aviso llega sin notificación.
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      // Una por chat o pedido: la nueva reemplaza a la anterior y vuelve a sonar.
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: level.icon,
      badge: "/icons/badge-96.png",
      timestamp: data.at || Date.now(),
      vibrate: level.vibrate,
      requireInteraction: level.requireInteraction,
      data: { url: data.url || "/viajes" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/viajes", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        // El portal ya está abierto: se trae al frente y él mismo va al chat o al pedido.
        try {
          await open.focus();
        } catch {}
        open.postMessage({ type: "abrir", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// El navegador cambió la suscripción por su cuenta: se guarda la nueva.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription?.options;
      const subscription =
        event.newSubscription ||
        (options ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey }) : null);
      if (!subscription) return;
      await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
    })(),
  );
});
