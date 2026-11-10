"use client";

import { signalState } from "@dispatch/shared/domain/gps";
import { isTripOpen } from "@dispatch/shared/domain/phase";
import { useEffect, useState } from "react";

import { Modal } from "@/components/Modal";
import { useTrips } from "@/components/TripsProvider";
import type { Courier, Trip } from "@/lib/types";
import { useNow } from "@/lib/use-now";

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (g: number) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * A quién darle el pedido. Primero los libres y después los que van en la calle,
 * con cuántos pedidos llevan y a qué distancia de la recogida están: el sistema
 * sugiere y la central decide (docs/INTERVENCION-MANUAL.md).
 */
export function AssignDialog({ trip, onAssign, onClose }: { trip: Trip; onAssign: (courierId: number | null) => Promise<boolean>; onClose: () => void }) {
  const { trips } = useTrips();
  const now = useNow(null);
  const [couriers, setCouriers] = useState<Courier[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/couriers", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: Courier[]) => {
        if (!cancelled) setCouriers(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = (couriers ?? [])
    .filter((c) => (c.status === "available" || c.status === "busy") && c.assignable !== false && c.id !== trip.courierId)
    .map((c) => {
      // Solo con la moto en vivo se dice a qué distancia está (domain/gps.ts).
      const signal = signalState(c, now);
      return {
        courier: c,
        signal,
        carrying: trips.filter((t) => t.courierId === c.id && isTripOpen(t)).length,
        distance: signal === "live" && trip.pickupLocation ? km({ lat: c.lat!, lng: c.lng! }, trip.pickupLocation) : null,
      };
    })
    .sort((a, b) => a.carrying - b.carrying || (a.distance ?? Infinity) - (b.distance ?? Infinity));

  async function choose(courierId: number | null) {
    setFailed(false);
    if (await onAssign(courierId)) onClose();
    else setFailed(true);
  }

  return (
    <Modal label={`Asignar ${trip.code}`} onClose={onClose}>
      <p className="text-base font-semibold text-ink">¿Quién lleva {trip.code}?</p>
      <div className="no-scrollbar flex max-h-72 flex-col gap-2 overflow-y-auto">
        {!couriers && !failed && <p className="animate-pulse text-sm text-ink-3">Cargando motos…</p>}
        {couriers && options.length === 0 && <p className="text-sm text-ink-3">No hay motos conectadas.</p>}
        {options.map(({ courier, carrying, distance, signal }) => (
          <button
            key={courier.id}
            type="button"
            onClick={() => choose(courier.id)}
            className="ease-ui flex min-h-11 items-center justify-between gap-3 rounded-xl bg-clapi-soft px-3 py-2 text-left text-sm font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
          >
            <span className="min-w-0 truncate">{courier.name}</span>
            <span className="shrink-0 text-xs font-medium opacity-80">
              {carrying ? `${carrying} ${carrying === 1 ? "pedido" : "pedidos"}` : "Libre"}
              {distance !== null ? ` · ${distance.toFixed(1)} km` : signal === "lost" ? " · sin señal" : ""}
            </span>
          </button>
        ))}
      </div>
      {failed && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">No se pudo: quizá ya lo recogieron o esa moto ya no está disponible.</p>}
      {trip.status !== "pending" && (
        <button type="button" onClick={() => choose(null)} className="ease-ui h-10 rounded-xl bg-sunken text-sm font-semibold text-ink-2">
          Que se asigne solo
        </button>
      )}
      <button type="button" onClick={onClose} className="ease-ui h-10 rounded-xl bg-sunken text-sm font-semibold text-ink-2">
        Cancelar
      </button>
    </Modal>
  );
}
