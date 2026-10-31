"use client";

import { useEffect } from "react";

/**
 * El mapa de zonas sin cobertura es una página aparte, a pantalla completa
 * (`public/zonas/mapa.html`, protegida por la sesión como todo el portal):
 * Leaflet con las calles de Cali y Jamundí, y guarda en `/api/zonas`.
 */
export default function ZonasPage() {
  useEffect(() => {
    window.location.replace("/zonas/mapa.html");
  }, []);
  return <p className="px-5 py-12 text-center text-sm text-ink-3">Abriendo el mapa…</p>;
}
