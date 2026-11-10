import type { MetadataRoute } from "next";

import { BRAND } from "@/lib/brand";

/**
 * El portal instalable como app: ícono de Clapi en la pantalla de inicio y a
 * pantalla completa, sin la barra del navegador. Lo pide el celular sin
 * cookie: proxy.ts lo deja pasar sin sesión.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: `${BRAND.platform.name} ${BRAND.platform.product} · ${BRAND.client.name}`,
    short_name: "Clapi",
    description: `Central de despachos de ${BRAND.client.name}`,
    lang: "es-CO",
    start_url: "/viajes",
    scope: "/",
    display: "standalone",
    background_color: "#0d0b14",
    theme_color: "#0d0b14",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
