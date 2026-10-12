import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";

import { BRAND } from "@/lib/brand";
import "./globals.css";

// La tipografía de la guía de marca. next/font la descarga al compilar y la
// sirve desde el mismo dominio: el navegador no le pide nada a Google.
const sora = Sora({ subsets: ["latin"], display: "swap", variable: "--font-sora" });

export const metadata: Metadata = {
  title: `${BRAND.client.name} · Central de despachos`,
  description: `Despachos en vivo — tecnología ${BRAND.platform.name}`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d0b14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={sora.variable} style={{ "--client": BRAND.client.primary } as React.CSSProperties}>
      <body>{children}</body>
    </html>
  );
}
