"use client";

import { Banknote, Check, CheckCircle2, CreditCard } from "lucide-react";
import { motion } from "motion/react";
import { memo } from "react";

import { PhoneLink } from "@/components/PhoneLink";
import { formatCOP, initials } from "@/lib/format";
import type { Trip } from "@/lib/types";
import { clock, useAfter, useNow } from "@/lib/use-now";

/**
 * El cronómetro de cada tarjeta y sus umbrales. Pendiente: lo que importa es
 * cuánto lleva sin moto (2 min ya es mucho). En ruta: cuánto lleva en la
 * calle desde que se asignó (prometemos 10-15 min de recogida, así que pasado
 * 25 algo anda mal).
 */
function Timer({ trip }: { trip: Trip }) {
  // Solo los que corren se actualizan cada segundo; un entregado no cambia.
  const now = useNow(trip.status === "pending" || trip.status === "en_route" ? 1000 : null);
  const pill = "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums";
  if (trip.status === "pending") {
    const s = (now - new Date(trip.createdAt).getTime()) / 1000;
    const tone = s > 120 ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn";
    return <span className={`${pill} ${tone}`}>{clock(s)}</span>;
  }
  if (trip.status === "en_route" && trip.assignedAt) {
    const s = (now - new Date(trip.assignedAt).getTime()) / 1000;
    const tone = s > 35 * 60 ? "bg-danger-soft text-danger" : s > 25 * 60 ? "bg-warn-soft text-warn" : "bg-clapi-soft text-clapi-ink";
    return (
      <span className={`${pill} ${tone}`}>
        <span className="h-1.5 w-1.5 animate-live rounded-full bg-current" />
        {clock(s)}
      </span>
    );
  }
  if (trip.status === "delivered") {
    const at = trip.deliveredAt ? new Date(trip.deliveredAt) : null;
    return (
      <span className={`${pill} bg-clapi-soft text-clapi-ink`}>
        <CheckCircle2 size={13} className="text-ok" />
        {at ? at.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "Entregado"}
      </span>
    );
  }
  return null;
}

/**
 * La tarjeta no depende del reloj: solo el cronómetro (`Timer`) late cada
 * segundo. Antes la tarjeta entera, con su animación de `layout`, se volvía a
 * medir y dibujar cada segundo por cada viaje en pantalla. `memo`: si el viaje
 * no cambió, una actualización del tablero tampoco la toca.
 */
export const TripCard = memo(function TripCard({ trip, onDeliver }: { trip: Trip; onDeliver: (id: number) => void }) {
  const urgent = useAfter(trip.status === "pending" ? Date.parse(trip.createdAt) + 120_000 : null);
  const assignedFor8s = useAfter(trip.status === "en_route" && trip.assignedAt ? Date.parse(trip.assignedAt) + 8000 : null);
  const justAssigned = trip.status === "en_route" && trip.assignedAt !== null && !assignedFor8s;
  const cash = trip.paymentMethod === "efectivo";

  return (
    <motion.article
      layout
      layoutId={`trip-${trip.id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className={`card flex flex-col gap-2.5 p-3.5 ${urgent ? "animate-urgent" : ""} ${justAssigned ? "animate-assigned" : ""}`}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tracking-tight">{trip.code}</span>
        <Timer trip={trip} />
      </header>

      {/* Recorrido A → B: el conector sale del punto de recogida y llega al de entrega. */}
      <div className="flex flex-col">
        <div className="relative pb-3 pl-7">
          <span className="absolute left-0 top-0.5 h-4 w-4 rounded-full border-2 border-clapi bg-surface" />
          <span className="absolute bottom-0 left-[7px] top-5 w-0.5 rounded-full bg-linear-to-b from-clapi/30 to-clapi" />
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Recoge</p>
          <p className="text-sm font-semibold leading-snug">{trip.originRestaurantName}</p>
        </div>
        <div className="relative pl-7">
          <span className="absolute left-0 top-0.5 h-4 w-4 rounded-full bg-clapi" />
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Entrega</p>
          <p className="text-sm leading-snug text-ink">{trip.deliveryAddress}</p>
        </div>
      </div>

      {trip.deliveryFee > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <span className="rounded-full bg-clapi-soft px-2.5 py-0.5 font-semibold text-clapi-ink">Domicilio {formatCOP(trip.deliveryFee)}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Método de pago y cliente son opcionales: sin el dato no se muestra nada. */}
        {cash ? (
          <span className="flex items-center gap-1.5 rounded-full bg-gold px-3 py-1.5 text-xs font-bold text-clapi-deep">
            <Banknote size={14} />
            Cobrar {trip.valueToCollect != null && formatCOP(trip.valueToCollect)}
          </span>
        ) : trip.paymentMethod === "transferencia" ? (
          <span className="flex items-center gap-1.5 rounded-full bg-ok-soft px-3 py-1.5 text-xs font-bold text-ok">
            <CreditCard size={14} />
            Pre-pagado{trip.valueToCollect != null && ` · ${formatCOP(trip.valueToCollect)}`}
          </span>
        ) : null}
        {/* El cliente final no tiene chat con el bot: su número solo llama. */}
        {trip.customerPhone && <PhoneLink phone={trip.customerPhone} name="Cliente" pill call />}
      </div>

      {/* Una sola línea: avatar, nombre, chat y llamada; en "En ruta", el botón Entregado al final. */}
      <footer className="flex items-center gap-2 border-t border-gray-100 pt-2.5">
        {trip.courierName ? (
          <>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-clapi text-[11px] font-bold text-white">
              {initials(trip.courierName)}
            </span>
            <p className="min-w-0 truncate text-sm font-medium leading-tight">{trip.courierName}</p>
            {/* Del motorizado no se muestra el número: un botón abre su chat y el otro lo llama. */}
            {trip.courierPhone && (
              <div className="flex shrink-0 items-center gap-1.5 text-ink-3">
                <PhoneLink phone={trip.courierPhone} name={trip.courierName} iconOnly />
                <PhoneLink phone={trip.courierPhone} name={trip.courierName} call iconOnly />
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm text-ink-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-ink-3/40">
              <span className="h-1.5 w-1.5 animate-live rounded-full bg-warn" />
            </span>
            Buscando moto libre…
          </div>
        )}

        {trip.status === "en_route" && (
          <button
            type="button"
            onClick={() => onDeliver(trip.id)}
            className="ease-ui ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-clapi-soft px-3 text-xs font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
          >
            <Check size={14} />
            Entregado
          </button>
        )}
      </footer>
    </motion.article>
  );
});
