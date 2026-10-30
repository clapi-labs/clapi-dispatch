"use client";

import { useEffect, useRef } from "react";

/**
 * Datos en vivo sin preguntar a cada rato. Una sola conexión por pestaña a
 * /api/events: el servidor avisa qué tabla cambió y cada pantalla vuelve a
 * pedir solo si es una de las suyas.
 *
 * Mientras los avisos no lleguen (conexión caída, o una base sin LISTEN) cada
 * pantalla vuelve a preguntar cada `FALLBACK_MS`; con los avisos activos, solo
 * un repaso cada `SAFETY_MS` por si se perdió alguno. Con la pestaña oculta no
 * se pide nada, y al volver se actualiza enseguida.
 */

export type Topic = "trips" | "assignments" | "couriers" | "conversations" | "messages";

const FALLBACK_MS = 3000;
const SAFETY_MS = 60_000;
// Un cambio suele tocar varias tablas seguidas (viaje + asignación): se juntan.
const DEBOUNCE_MS = 150;

type Subscriber = { topics: readonly Topic[]; run: () => void };

const subscribers = new Set<Subscriber>();
let source: EventSource | null = null;
let live = false;

function ensureSource() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  source.addEventListener("ready", () => {
    // Pudo cambiar algo mientras no había avisos: todos se ponen al día.
    live = true;
    for (const s of subscribers) s.run();
  });
  source.addEventListener("down", () => {
    live = false;
  });
  source.onerror = () => {
    live = false;
  };
  source.onmessage = (e) => {
    for (const s of subscribers) if (s.topics.includes(e.data as Topic)) s.run();
  };
}

/** Corre `fn` al montar, cuando cambia alguna de `topics` y al volver a la
 *  pestaña. `fn` puede cambiar entre renders: siempre se usa la última. */
export function useLive(fn: () => unknown, topics: readonly Topic[], enabled = true) {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const key = topics.join(",");

  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;

    const run = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        if (document.visibilityState === "hidden") return;
        last = Date.now();
        fnRef.current();
      }, DEBOUNCE_MS);
    };

    const sub: Subscriber = { topics: key.split(",") as Topic[], run };
    subscribers.add(sub);
    ensureSource();
    run();

    const tick = setInterval(() => {
      if (Date.now() - last >= (live ? SAFETY_MS : FALLBACK_MS)) run();
    }, FALLBACK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      subscribers.delete(sub);
      clearInterval(tick);
      if (pending) clearTimeout(pending);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, enabled]);
}
