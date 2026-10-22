import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Salida mínima para Docker: server.js + solo las dependencias que se usan.
  output: "standalone",
  // Monorepo: el trazado debe partir de la raíz para incluir packages/shared.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
