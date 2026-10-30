"use client";

import { Bike } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { DEMO, installDemo } from "@/lib/demo";
import { playChime, unlockAudio } from "@/lib/sound";
import type { Trip } from "@/lib/types";
import { usePolling } from "@/lib/use-polling";

/**
 * Los viajes viven acá y no en cada página: así la alerta de "moto asignada"
 * suena esté donde esté el despachador — viendo chats, flota o arqueo — y
 * los contadores de la navegación están siempre al día.
 */

type TripsState = {
  trips: Trip[];
  /** Chats que piden ayuda a una persona: la burbuja amarilla de Conversaciones. */
  needsHelp: number;
  loaded: boolean;
  online: boolean;
  soundOn: boolean;
  setSoundOn: (on: boolean) => void;
  deliver: (tripId: number) => Promise<void>;
};

// Con NEXT_PUBLIC_DEMO=1 las rutas /api/* responden con datos de ejemplo (lib/demo.ts).
// Va aquí, al cargar el módulo: antes de que cualquier pantalla pida algo.
installDemo();

const TripsContext = createContext<TripsState | null>(null);

const POLL_MS = 3000;

export function TripsProvider({ children }: { children: React.ReactNode }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [needsHelp, setNeedsHelp] = useState(0);
  const lastHelp = useRef<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const [toast, setToast] = useState<Trip | null>(null);

  const seenAssigned = useRef<Set<number> | null>(null);
  const soundRef = useRef(soundOn);
  useEffect(() => {
    soundRef.current = soundOn;
  }, [soundOn]);

  const refresh = useCallback(async () => {
    try {
      // Si se liberó una moto (entregó desde su app), los pendientes la toman.
      await fetch("/api/dispatch/auto-assign", { method: "POST" });
      // El contador de ayuda va en paralelo: no le suma espera al sondeo.
      const [res, help] = await Promise.all([
        fetch("/api/trips", { cache: "no-store" }),
        fetch("/api/conversations/needs-help", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (!res.ok) throw new Error(String(res.status));
      const data: Trip[] = await res.json();

      if (help && typeof help.count === "number") {
        // Suena cuando un chat nuevo pide ayuda; no en la primera carga.
        if (lastHelp.current !== null && help.count > lastHelp.current && soundRef.current) playChime();
        lastHelp.current = help.count;
        setNeedsHelp(help.count);
      }

      const assigned = data.filter((t) => t.assignedAt && t.status !== "pending");
      // La primera carga solo aprende qué existía: no suena por lo viejo.
      if (seenAssigned.current) {
        const fresh = assigned.filter((t) => !seenAssigned.current!.has(t.id));
        if (fresh.length > 0) {
          if (soundRef.current) playChime();
          setToast(fresh[0]);
        }
      }
      seenAssigned.current = new Set(assigned.map((t) => t.id));

      setTrips(data);
      setLoaded(true);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  usePolling(refresh, POLL_MS);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  const deliver = useCallback(
    async (tripId: number) => {
      setTrips((prev) => prev.map((t) => (t.id === tripId ? { ...t, status: "delivered", deliveredAt: new Date().toISOString() } : t)));
      await fetch(`/api/trips/${tripId}/deliver`, { method: "POST" });
      refresh();
    },
    [refresh],
  );

  return (
    <TripsContext.Provider value={{ trips, needsHelp, loaded, online, soundOn, setSoundOn, deliver }}>
      {children}

      {DEMO && (
        <span className="pointer-events-none fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-3 z-50 rounded-full bg-gold px-2.5 py-1 text-[11px] font-bold text-clapi-deep shadow lg:bottom-3 lg:left-auto lg:right-3">
          Datos de ejemplo
        </span>
      )}

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.75rem)] z-50 flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-3 rounded-2xl bg-clapi-deep px-4 py-3 text-white shadow-xl shadow-clapi/20 ring-1 ring-white/15"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold text-clapi-deep">
              <Bike size={18} strokeWidth={2.4} />
            </span>
            <div className="min-w-0 text-sm leading-tight">
              <p className="font-semibold">Moto asignada · {toast.code}</p>
              <p className="truncate text-white/70">
                {toast.courierName} → {toast.deliveryAddress}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </TripsContext.Provider>
  );
}

export function useTrips() {
  const ctx = useContext(TripsContext);
  if (!ctx) throw new Error("useTrips fuera de TripsProvider");
  return ctx;
}
