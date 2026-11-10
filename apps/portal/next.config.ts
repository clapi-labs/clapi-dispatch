import path from "node:path";
import type { NextConfig } from "next";

/**
 * Content-Security-Policy: de dónde puede cargar cosas el portal. Si alguien
 * lograra meter código en una página (por ejemplo, en un mensaje de WhatsApp
 * que se muestra en Conversaciones), el navegador no carga scripts de otros
 * sitios ni le manda datos a otro servidor.
 *
 * - script-src: 'unsafe-inline' porque Next mete sus propios scripts en la
 *   página; quitarlo exige nonces y que todas las páginas sean dinámicas.
 *   Leaflet (simulador y mapas de zonas) solo esa versión exacta, y con SRI.
 *   En desarrollo, Next necesita 'unsafe-eval' para recargar en caliente.
 * - style-src 'unsafe-inline': atributos style de React y del mapa. Google
 *   Fonts: la tipografía de los mapas de zonas (public/zonas/*.html).
 * - img-src: fotos de perfil (data:) y los mapas de OpenStreetMap. Si se usa
 *   un logo de otro dominio (NEXT_PUBLIC_CLIENT_LOGO), hay que agregarlo aquí.
 * - connect-src 'self': fetch y los avisos en vivo (/api/events) solo al portal.
 * - frame-ancestors 'none': nadie puede meter el portal en un iframe.
 */
const dev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Salida mínima para Docker: server.js + solo las dependencias que se usan.
  output: "standalone",
  // Monorepo: el trazado debe partir de la raíz para incluir packages/shared.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: csp }] }];
  },
};

export default nextConfig;
