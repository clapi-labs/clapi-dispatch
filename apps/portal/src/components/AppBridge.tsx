"use client";

import { useEffect } from "react";

import { captureInstallPrompt, isStandalone, registerServiceWorker, syncPush } from "@/lib/push";

/**
 * Lo que une el portal con el celular, sin nada que dibujar: instala el
 * service worker de las alertas, alarga a 30 días la sesión si el portal se
 * abrió instalado, vuelve a guardar las alertas de este equipo con la sesión
 * de ahora y, cuando se toca una notificación con el portal ya abierto, lo
 * lleva al chat o al pedido.
 */
export function AppBridge() {
  useEffect(() => {
    registerServiceWorker()?.catch(() => {});
    if (isStandalone()) {
      fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installed: true }),
      }).catch(() => {});
    }
    syncPush().catch(() => {});
  }, []);

  useEffect(() => captureInstallPrompt(), []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "abrir" || typeof event.data.url !== "string") return;
      const target = new URL(event.data.url, window.location.origin);
      if (target.origin !== window.location.origin) return;
      // Misma pantalla: basta con el fragmento (#tel=…, #pedido=…), que la
      // pantalla escucha. Otra pantalla: se carga con el fragmento puesto.
      if (target.pathname === window.location.pathname) window.location.hash = target.hash;
      else window.location.assign(target.href);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  return null;
}
