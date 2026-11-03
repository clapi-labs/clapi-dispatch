"use client";

import { useEffect, useState } from "react";

/** La hora actual, re-renderizando cada `ms` (`null`: quieta). Para los cronómetros. */
export function useNow(ms: number | null = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** `true` desde el instante `at` (ms) en adelante. Re-renderiza una sola vez,
 *  al cruzarlo — no cada segundo como `useNow`. */
export function useAfter(at: number | null) {
  const [now, setNow] = useState(() => Date.now());
  const passed = at !== null && now >= at;
  useEffect(() => {
    if (at === null || passed) return;
    const id = setTimeout(() => setNow(Date.now()), at - Date.now());
    return () => clearTimeout(id);
  }, [at, passed]);
  return passed;
}

/** 00:00, o 1:02:03 pasada la hora. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
