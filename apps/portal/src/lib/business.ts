"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * La pausa general, compartida por todas las pantallas de la pestaña: una
 * sola consulta cada `POLL_MS` (cambia muy poco y solo desde el portal) y,
 * al pausar o reanudar aquí, se ve al instante.
 */
export type BusinessState = { paused: boolean; pausedAt: string | null };

const POLL_MS = 20_000;

let state: BusinessState = { paused: false, pausedAt: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(next: BusinessState) {
  state = next;
  for (const l of listeners) l();
}

async function load() {
  const res = await fetch("/api/business", { cache: "no-store" }).catch(() => null);
  if (res?.ok) publish(await res.json());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    load();
    timer = setInterval(load, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export async function setBusinessPaused(paused: boolean): Promise<boolean> {
  const previous = state;
  publish({ paused, pausedAt: paused ? new Date().toISOString() : null });
  const res = await fetch("/api/business", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  }).catch(() => null);
  if (res?.ok) {
    publish(await res.json());
    return true;
  }
  publish(previous);
  return false;
}

export function useBusiness(): BusinessState {
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  // Al volver a la pestaña, ponerse al día sin esperar el siguiente sondeo.
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return current;
}
