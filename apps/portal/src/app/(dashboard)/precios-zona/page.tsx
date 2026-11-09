"use client";

import { useEffect } from "react";

/**
 * El mapa de precio mínimo por zona es una página aparte, a pantalla completa
 * (`public/zonas/precios.html`, protegida por la sesión como todo el portal),
 * igual que el de zonas sin cobertura. Guarda en `/api/zonas-precio`.
 */
export default function PreciosZonaPage() {
  useEffect(() => {
    window.location.replace("/zonas/precios.html");
  }, []);
  return <p className="px-5 py-12 text-center text-sm text-ink-3">Abriendo el mapa…</p>;
}
