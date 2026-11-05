"use client";

import { useEffect, useRef } from "react";

/**
 * Pestañas que se cambian deslizando, como un carrusel. El contenedor es un
 * scroll horizontal con `snap` (lo mueve el navegador, sin JavaScript en cada
 * cuadro del dedo, así que es fluido y no pesa): cada pestaña es un panel del
 * ancho completo. Al soltar en otro panel, avisa con `onChange`; al tocar
 * una pestaña arriba, se desliza hasta su panel.
 *
 * En escritorio el contenedor deja de hacer scroll (todas las columnas se
 * ven) y esto no hace nada.
 */
export function useSwipePanes<K extends string>(
  keys: readonly K[],
  active: K,
  onChange: (key: K) => void,
) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef(active);
  const change = useRef(onChange);
  useEffect(() => {
    current.current = active;
    change.current = onChange;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const left = keys.indexOf(active) * el.clientWidth;
    if (Math.abs(el.scrollLeft - left) < 2) return;
    el.scrollTo({ left, behavior: "smooth" });
  }, [active, keys]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let fallback: ReturnType<typeof setTimeout> | undefined;

    function settle() {
      const key = keys[Math.round(el!.scrollLeft / el!.clientWidth)];
      if (key && key !== current.current) change.current(key);
    }
    // La pestaña cambia al soltar, no a mitad del gesto: así no pelea con el dedo.
    function onScroll() {
      // Sin `scrollend` (Safari viejo): se da por terminado cuando deja de moverse.
      clearTimeout(fallback);
      fallback = setTimeout(settle, 150);
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", settle);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", settle);
      clearTimeout(fallback);
    };
  }, [keys]);

  return ref;
}
