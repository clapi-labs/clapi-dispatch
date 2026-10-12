"use client";

import { ChevronDown, MapPin, MessageCircle, Pause, Play, Power, Trash2 } from "lucide-react";
import { useState } from "react";

import { CourierDetails } from "@/components/CourierDetails";
import { PhoneLink } from "@/components/PhoneLink";
import { initials } from "@/lib/format";
import { nearestZone } from "@/lib/geo";
import type { Courier } from "@/lib/types";

const STATUS: Record<Courier["status"], { dot: string; label: string; chip: string }> = {
  available: { dot: "bg-ok", label: "Libre", chip: "bg-ok-soft text-ok" },
  busy: { dot: "bg-gold", label: "En un viaje", chip: "bg-gold-soft text-gold-ink" },
  paused: { dot: "bg-ink-3", label: "En pausa", chip: "bg-sunken text-ink-3" },
  offline: { dot: "bg-danger", label: "Desconectado", chip: "bg-danger-soft text-danger" },
};

export function CourierCard({
  courier,
  queuePosition,
  onChange,
  onRemove,
}: {
  courier: Courier;
  /** Su turno en la cola si está libre: 1 = el próximo viaje es suyo. */
  queuePosition: number | null;
  onChange: (next: Courier["status"]) => void;
  onRemove: () => void;
}) {
  const status = STATUS[courier.status];
  const zone = courier.lat && courier.lng ? nearestZone(courier.lat, courier.lng) : null;
  // Con muchos motorizados la tarjeta se queda en el resumen; el resto se abre a pedido.
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="card flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-clapi text-sm font-bold text-white">
          {initials(courier.name)}
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-[3px] ring-surface ${status.dot} ${
              courier.status === "available" ? "animate-live" : ""
            }`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{courier.name}</p>
          <span className={`mt-0.5 inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${status.chip}`}>{status.label}</span>
        </div>
        {queuePosition !== null && (
          <span
            className={`flex h-10 min-w-10 flex-col items-center justify-center rounded-xl px-2 leading-none ${
              queuePosition === 1 ? "bg-clapi text-white" : "bg-sunken text-ink-2"
            }`}
            title="Turno en la cola"
          >
            <span className="text-[9px] font-semibold uppercase opacity-80">Turno</span>
            <span className="text-sm font-bold">{queuePosition}</span>
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-sunken px-3 py-2">
          <dt className="text-ink-3">Viajes hoy</dt>
          <dd className="text-base font-bold tabular-nums">{courier.deliveriesThisShift}</dd>
        </div>
        <div className="rounded-xl bg-sunken px-3 py-2">
          <dt className="flex items-center gap-1 text-ink-3">
            <MapPin size={11} className={courier.status !== "offline" ? "text-clapi" : ""} /> Última zona
          </dt>
          <dd className="truncate text-sm font-semibold">{zone ?? "Sin GPS"}</dd>
        </div>
      </dl>

      <div className="flex items-center gap-1.5 text-xs text-ink-3">
        <PhoneLink phone={courier.phone} name={courier.name} />
        <span className="ml-auto flex items-center gap-1 font-medium text-ok">
          <MessageCircle size={12} /> Recibe viajes por WhatsApp
        </span>
      </div>

      <div className="flex gap-2">
        {courier.status === "paused" || courier.status === "offline" ? (
          <button
            type="button"
            onClick={() => onChange("available")}
            className="ease-ui flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-ok-soft text-sm font-semibold text-ok"
          >
            <Play size={14} /> Activar
          </button>
        ) : (
          <button
            type="button"
            disabled={courier.status === "busy"}
            onClick={() => onChange("paused")}
            className="ease-ui flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-sunken text-sm font-semibold text-ink-2 disabled:opacity-40"
          >
            <Pause size={14} /> Pausar
          </button>
        )}
        <button
          type="button"
          disabled={courier.status === "busy" || courier.status === "offline"}
          onClick={() => onChange("offline")}
          aria-label="Desconectar"
          className="ease-ui flex h-10 w-10 items-center justify-center rounded-xl bg-sunken text-ink-3 disabled:opacity-40 can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
        >
          <Power size={15} />
        </button>
        <button
          type="button"
          disabled={courier.status === "busy"}
          onClick={onRemove}
          aria-label="Quitar de la flota"
          className="ease-ui flex h-10 w-10 items-center justify-center rounded-xl bg-sunken text-ink-3 disabled:opacity-40 can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="ease-ui -my-1 flex h-9 items-center justify-center gap-1 rounded-lg text-xs font-semibold text-ink-3 can-hover:hover:bg-sunken can-hover:hover:text-ink-2"
      >
        {expanded ? "Ver menos" : "Ver más"}
        <ChevronDown size={14} className={`ease-ui ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && <CourierDetails courier={courier} />}
    </article>
  );
}
