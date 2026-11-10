import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Salida mínima para Docker: server.js + solo las dependencias que se usan.
  output: "standalone",
  // Monorepo: el trazado debe partir de la raíz para incluir packages/shared.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // El service worker de las alertas: siempre la última versión, nunca de caché.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
