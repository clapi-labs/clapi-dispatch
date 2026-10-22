"use client";

import { Bike } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

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
  loaded: boolean;
  online: boolean;
  soundOn: boolean;
  setSoundOn: (on: boolean) => void;
  deliver: (tripId: number) => Promise<void>;
};

const TripsContext = createContext<TripsState | null>(null);

const POLL_MS = 3000;

export function TripsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
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
      const res = await fetch("/api/trips", { cache: "no-store" });
      // La sesión venció: de vuelta al login en vez de quedarse "sin conexión".
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data: Trip[] = await res.json();

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
  }, [router]);

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
    <TripsContext.Provider value={{ trips, loaded, online, soundOn, setSoundOn, deliver }}>
      {children}

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
