"use client";

import { useEffect } from "react";

/**
 * El mapa de zonas es una página aparte, a pantalla completa
 * (`public/zonas/mapa.html`, protegida por la sesión como todo el portal):
 * las zonas sin cobertura (`/api/zonas`) y las de precio mínimo
 * (`/api/zonas-precio`) sobre los barrios oficiales de Cali.
 */
export default function ZonasPage() {
  useEffect(() => {
    window.location.replace("/zonas/mapa.html");
  }, []);
  return <p className="px-5 py-12 text-center text-sm text-ink-3">Abriendo el mapa…</p>;
}
