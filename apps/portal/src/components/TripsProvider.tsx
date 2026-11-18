"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { criticalBlockedIds, hasNewCritical } from "@/lib/blockages";
import { DEMO, installDemo } from "@/lib/demo";
import { useLive } from "@/lib/live";
import { playChime, unlockAudio } from "@/lib/sound";
import type { Trip } from "@/lib/types";

/**
 * Los viajes viven acá y no en cada página: así el timbre de "un chat pide
 * ayuda" o "un viaje se atascó" (moto que no recoge, entrega o devolución estancada)
 * suena esté donde esté el despachador, y los contadores de la navegación están
 * siempre al día. Una moto asignada no suena: la tarjeta de Viajes solo se
 * actualiza.
 */

type TripsState = {
  trips: Trip[];
  /** Chats que piden ayuda a una persona: la burbuja amarilla de Conversaciones. */
  needsHelp: number;
  loaded: boolean;
  online: boolean;
  soundOn: boolean;
  setSoundOn: (on: boolean) => void;
  deliver: (tripId: number, outcome: DeliveryOutcome) => Promise<void>;
  /** Asigna a esa moto, o devuelve el viaje para que se asigne solo (`null`).
   *  `false` si ya no se pudo: otra moto lo tomó o ya lo recogieron. */
  assign: (tripId: number, courierId: number | null) => Promise<boolean>;
};

export type DeliveryOutcome = { place: "customer" | "gate" };

// Con NEXT_PUBLIC_DEMO=1 las rutas /api/* responden con datos de ejemplo (lib/demo.ts).
// Va aquí, al cargar el módulo: antes de que cualquier pantalla pida algo.
installDemo();

/** Los viajes que no cambiaron conservan el mismo objeto: así una tarjeta
 *  (`TripCard`, con `memo`) solo se redibuja si su viaje cambió de verdad. */
function keepUnchanged(prev: Trip[], next: Trip[]) {
  const before = new Map(prev.map((t) => [t.id, t]));
  return next.map((t) => {
    const old = before.get(t.id);
    return old && JSON.stringify(old) === JSON.stringify(t) ? old : t;
  });
}

const TripsContext = createContext<TripsState | null>(null);

const TRIP_TOPICS = ["trips", "assignments", "couriers"] as const;
const HELP_TOPICS = ["conversations", "messages"] as const;

export function TripsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [needsHelp, setNeedsHelp] = useState(0);
  const lastHelp = useRef<Set<number> | null>(null);
  const lastBlocked = useRef<Set<number> | null>(null);
  const tripsRef = useRef<Trip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [soundOn, setSoundOn] = useState(true);

  const soundRef = useRef(soundOn);
  useEffect(() => {
    soundRef.current = soundOn;
  }, [soundOn]);

  // El texto de la última respuesta: si llega igual, no se toca el estado y
  // nada se vuelve a dibujar.
  const lastBody = useRef<string | null>(null);

  // Suena cuando un viaje entra en un bloqueo crítico (no en la primera carga).
  // El bloqueo empieza con el paso del tiempo, no con un cambio en la base: por
  // eso se revisa también cada pocos segundos, no solo al traer los viajes.
  const checkBlocked = useCallback((list: Trip[]) => {
    const current = criticalBlockedIds(list);
    if (hasNewCritical(current, lastBlocked.current) && soundRef.current) playChime();
    lastBlocked.current = current;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/trips", { cache: "no-store" });
      // La sesión venció: de vuelta al login en vez de quedarse "sin conexión".
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.text();
      setOnline(true);
      setLoaded(true);
      if (body === lastBody.current) return;
      lastBody.current = body;
      const data: Trip[] = JSON.parse(body);

      tripsRef.current = data;
      checkBlocked(data);
      setTrips((prev) => keepUnchanged(prev, data));
    } catch {
      setOnline(false);
    }
  }, [router, checkBlocked]);

  const refreshHelp = useCallback(async () => {
    const help = await fetch("/api/conversations/needs-help", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!help || typeof help.count !== "number") return;
    // Suena cuando entra un chat que pide ayuda (no en la primera carga). Se
    // compara por id y no por la cuenta: si entra uno y sale otro a la vez, la
    // cuenta queda igual pero hay un caso nuevo.
    const ids: number[] = Array.isArray(help.ids) ? help.ids : [];
    const seen = lastHelp.current;
    if (seen !== null && ids.some((id) => !seen.has(id)) && soundRef.current) playChime();
    lastHelp.current = new Set(ids);
    setNeedsHelp(help.count);
  }, []);

  // Los viajes, solo cuando cambian viajes, asignaciones o motos (el nombre
  // del motorizado sale de ahí); el contador de ayuda, cuando cambian chats.
  useLive(refresh, TRIP_TOPICS);
  useLive(refreshHelp, HELP_TOPICS);

  useEffect(() => {
    const id = setInterval(() => {
      if (lastBlocked.current !== null) checkBlocked(tripsRef.current);
    }, 15_000);
    return () => clearInterval(id);
  }, [checkBlocked]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const deliver = useCallback(
    async (tripId: number, { place }: DeliveryOutcome) => {
      const now = new Date().toISOString();
      setTrips((prev) => prev.map((t) => (t.id === tripId ? { ...t, status: "delivered", deliveredAt: now, deliveryPlace: place, finishedAt: now } : t)));
      await fetch(`/api/trips/${tripId}/deliver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place }),
      });
      refresh();
    },
    [refresh],
  );

  const assign = useCallback(
    async (tripId: number, courierId: number | null) => {
      const res = await fetch(`/api/trips/${tripId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courierId }),
      });
      refresh();
      return res.ok;
    },
    [refresh],
  );

  // El mismo objeto mientras nada cambie: así no se redibuja todo el que lo usa.
  const value = useMemo(
    () => ({ trips, needsHelp, loaded, online, soundOn, setSoundOn, deliver, assign }),
    [trips, needsHelp, loaded, online, soundOn, deliver, assign],
  );

  return (
    <TripsContext.Provider value={value}>
      {children}

      {DEMO && (
        <span className="pointer-events-none fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-3 z-50 rounded-full bg-gold px-2.5 py-1 text-[11px] font-bold text-clapi-deep shadow lg:bottom-3 lg:left-auto lg:right-3">
          Datos de ejemplo
        </span>
      )}
    </TripsContext.Provider>
  );
}

export function useTrips() {
  const ctx = useContext(TripsContext);
  if (!ctx) throw new Error("useTrips fuera de TripsProvider");
  return ctx;
}
