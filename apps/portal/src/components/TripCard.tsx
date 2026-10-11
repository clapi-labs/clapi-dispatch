"use client";

import { Banknote, Check, CheckCircle2, CreditCard } from "lucide-react";
import { motion } from "motion/react";

import { PhoneLink } from "@/components/PhoneLink";
import { formatCOP, initials } from "@/lib/format";
import type { Trip } from "@/lib/types";
import { clock, useNow } from "@/lib/use-now";

/**
 * El cronómetro de cada tarjeta y sus umbrales. Pendiente: lo que importa es
 * cuánto lleva sin moto (2 min ya es mucho). En ruta: cuánto lleva en la
 * calle desde que se asignó (prometemos 10-15 min de recogida, así que pasado
 * 25 algo anda mal).
 */
function Timer({ trip, now }: { trip: Trip; now: number }) {
  if (trip.status === "pending") {
    const s = (now - new Date(trip.createdAt).getTime()) / 1000;
    const tone = s > 120 ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn";
    return <span className={`rounded-lg px-2 py-1 font-mono text-xs font-semibold tabular-nums ${tone}`}>{clock(s)}</span>;
  }
  if (trip.status === "en_route" && trip.assignedAt) {
    const s = (now - new Date(trip.assignedAt).getTime()) / 1000;
    const tone = s > 35 * 60 ? "bg-danger-soft text-danger" : s > 25 * 60 ? "bg-warn-soft text-warn" : "bg-clapi-soft text-clapi-ink";
    return (
      <span className={`flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-xs font-semibold tabular-nums ${tone}`}>
        <span className="h-1.5 w-1.5 animate-live rounded-full bg-current" />
        {clock(s)}
      </span>
    );
  }
  if (trip.status === "delivered") {
    const at = trip.deliveredAt ? new Date(trip.deliveredAt) : null;
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-ok">
        <CheckCircle2 size={14} />
        {at ? at.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "Entregado"}
      </span>
    );
  }
  return null;
}

export function TripCard({ trip, onDeliver }: { trip: Trip; onDeliver: (id: number) => void }) {
  const now = useNow(1000);
  const urgent = trip.status === "pending" && now - new Date(trip.createdAt).getTime() > 120_000;
  const justAssigned = trip.status === "en_route" && trip.assignedAt && now - new Date(trip.assignedAt).getTime() < 8000;
  const cash = trip.paymentMethod === "efectivo";

  return (
    <motion.article
      layout
      layoutId={`trip-${trip.id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className={`card flex flex-col gap-3 p-4 ${urgent ? "animate-urgent" : ""} ${justAssigned ? "animate-assigned" : ""}`}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-ink-3">{trip.code}</span>
        <Timer trip={trip} now={now} />
      </header>

      {/* Recorrido A → B, con la línea que los une. */}
      <div className="relative flex flex-col gap-3 pl-6">
        <span className="absolute bottom-2 left-[7px] top-2 w-px bg-line" />
        <div className="relative">
          <span className="absolute -left-6 top-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full border-2 border-clapi bg-surface" />
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Recoge</p>
          <p className="text-sm font-semibold leading-snug">{trip.originRestaurantName}</p>
        </div>
        <div className="relative">
          <span className="absolute -left-6 top-0.5 h-[15px] w-[15px] rounded-full bg-client" />
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Entrega</p>
          <p className="text-sm leading-snug text-ink">{trip.deliveryAddress}</p>
        </div>
      </div>

      {trip.deliveryFee > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <span className="rounded-md bg-client-soft px-2 py-0.5 font-bold text-client">Domicilio {formatCOP(trip.deliveryFee)}</span>
          {(trip.pickupZone || trip.deliveryZone) && (
            <span>
              {trip.pickupZone ?? "Fuera de zona"} → {trip.deliveryZone ?? "Fuera de zona"}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {cash ? (
          <span className="flex items-center gap-1.5 rounded-lg bg-gold-soft px-2.5 py-1.5 text-xs font-bold text-gold-ink">
            <Banknote size={14} />
            Cobrar {formatCOP(trip.valueToCollect)}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-lg bg-ok-soft px-2.5 py-1.5 text-xs font-bold text-ok">
            <CreditCard size={14} />
            Pre-pagado · {formatCOP(trip.valueToCollect)}
          </span>
        )}
        <PhoneLink phone={trip.customerPhone} name="Cliente" className="text-xs text-ink-3" />
      </div>

      <footer className="flex items-center gap-2.5 border-t border-line pt-3">
        {trip.courierName ? (
          <>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-clapi text-xs font-bold text-white">
              {initials(trip.courierName)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-medium">{trip.courierName}</p>
              <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
                {trip.status === "delivered" ? "Entregó" : "En camino"}
                {trip.courierPhone && <PhoneLink phone={trip.courierPhone} name={trip.courierName} />}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center gap-2 text-sm text-ink-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-ink-3/40">
              <span className="h-1.5 w-1.5 animate-live rounded-full bg-warn" />
            </span>
            Buscando moto libre…
          </div>
        )}

        {trip.status === "en_route" && (
          <button
            type="button"
            onClick={() => onDeliver(trip.id)}
            className="ease-ui flex h-9 items-center gap-1.5 rounded-lg bg-sunken px-3 text-xs font-semibold text-ink-2 can-hover:hover:bg-ok-soft can-hover:hover:text-ok"
          >
            <Check size={14} />
            Entregado
          </button>
        )}
      </footer>
    </motion.article>
  );
}
