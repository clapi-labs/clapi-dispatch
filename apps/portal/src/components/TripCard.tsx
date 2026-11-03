"use client";

import { Banknote, Check, CheckCircle2, ChevronDown, CreditCard, MapPin } from "lucide-react";
import { motion } from "motion/react";
import { memo, useState } from "react";

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
  const pill = "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums";
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
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
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

/** Cómo se paga, para el desplegable. Sin el dato, nada. */
function Payment({ trip }: { trip: Trip }) {
  const value = trip.valueToCollect != null ? ` · ${formatCOP(trip.valueToCollect)}` : "";
  if (trip.paymentMethod === "efectivo")
    return (
      <span className="flex items-center gap-1.5 font-semibold text-gold-ink">
        <Banknote size={13} /> Efectivo{value}
      </span>
    );
  if (trip.paymentMethod === "transferencia")
    return (
      <span className="flex items-center gap-1.5 font-semibold text-ok">
        <CreditCard size={13} /> Prepagado{value}
      </span>
    );
  return null;
}

/**
 * Compacta para que quepan muchas: código, restaurante, valor del domicilio,
 * cronómetro, a dónde va y quién lo lleva. Lo demás (cliente, pago, notas,
 * direcciones completas) se despliega tocando la tarjeta en el celular o la
 * flecha en el computador.
 *
 * La tarjeta no depende del reloj: solo el cronómetro (`Timer`) late cada
 * segundo. `memo`: si el viaje no cambió, una actualización del tablero
 * tampoco la toca.
 */
export const TripCard = memo(function TripCard({ trip, onDeliver }: { trip: Trip; onDeliver: (id: number) => void }) {
  const urgent = useAfter(trip.status === "pending" ? Date.parse(trip.createdAt) + 120_000 : null);
  const assignedFor8s = useAfter(trip.status === "en_route" && trip.assignedAt ? Date.parse(trip.assignedAt) + 8000 : null);
  const justAssigned = trip.status === "en_route" && trip.assignedAt !== null && !assignedFor8s;
  const [open, setOpen] = useState(false);

  // Tocar cualquier parte la abre o la cierra, menos sus botones y enlaces.
  function toggle(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("a, button")) return;
    setOpen((v) => !v);
  }

  return (
    <motion.article
      layout
      layoutId={`trip-${trip.id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      onClick={toggle}
      className={`card flex cursor-pointer flex-col gap-1.5 p-3 ${urgent ? "animate-urgent" : ""} ${justAssigned ? "animate-assigned" : ""}`}
    >
      <header className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-xs font-semibold text-ink-3">{trip.code}</span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{trip.originRestaurantName}</p>
        {trip.deliveryFee > 0 && <span className="shrink-0 text-sm font-bold tabular-nums text-clapi-ink">{formatCOP(trip.deliveryFee)}</span>}
        <Timer trip={trip} />
      </header>

      {trip.pickupAddress && <p className="-mt-1 truncate text-[11px] text-ink-3">{trip.pickupAddress}</p>}

      <p className={`flex items-start gap-1.5 text-sm text-ink-2 ${open ? "" : "truncate"}`}>
        <MapPin size={14} className="mt-0.5 shrink-0 text-clapi" />
        <span className={open ? "" : "truncate"}>{trip.deliveryAddress}</span>
      </p>

      <footer className="flex items-center gap-2">
        {trip.courierName ? (
          <>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-clapi text-[10px] font-bold text-white">
              {initials(trip.courierName)}
            </span>
            <p className="min-w-0 truncate text-xs font-medium">{trip.courierName}</p>
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-ink-3">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" /> Sin asignar
          </p>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {trip.status === "en_route" && (
            <button
              type="button"
              onClick={() => onDeliver(trip.id)}
              className="ease-ui flex h-8 items-center gap-1 rounded-lg bg-clapi-soft px-2.5 text-xs font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
            >
              <Check size={13} /> Entregado
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Ocultar detalles" : "Ver detalles"}
            className="ease-ui flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 can-hover:hover:bg-sunken can-hover:hover:text-ink-2"
          >
            <ChevronDown size={16} className={`ease-ui ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </footer>

      {open && (
        <div className="mt-1 flex flex-col gap-2 border-t border-line pt-2.5 text-xs">
          {(trip.customerName || trip.customerPhone) && (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="text-ink-3">Cliente </span>
                <span className="font-medium">{trip.customerName ?? "Sin nombre"}</span>
              </span>
              {/* El cliente final no tiene chat con el bot: su número solo llama. */}
              {trip.customerPhone && <PhoneLink phone={trip.customerPhone} name="Cliente" pill call />}
            </div>
          )}
          <Payment trip={trip} />
          {trip.notes && <p className="rounded-lg bg-sunken px-2.5 py-1.5 text-ink-2">{trip.notes}</p>}
          {trip.courierName && trip.courierPhone && (
            <div className="flex items-center gap-2">
              <span className="text-ink-3">Domiciliario</span>
              <div className="ml-auto flex items-center gap-1.5">
                <PhoneLink phone={trip.courierPhone} name={trip.courierName} iconOnly />
                <PhoneLink phone={trip.courierPhone} name={trip.courierName} call iconOnly />
              </div>
            </div>
          )}
        </div>
      )}
    </motion.article>
  );
});
