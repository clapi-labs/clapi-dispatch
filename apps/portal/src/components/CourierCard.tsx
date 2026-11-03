"use client";

import { Check, ChevronDown, Copy, LocateFixed, Power, PowerOff, Siren, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { CourierDetails } from "@/components/CourierDetails";
import { PhoneLink } from "@/components/PhoneLink";
import { chatHref } from "@/lib/chat";
import { copyText } from "@/lib/clipboard";
import { elapsedLabel, formatPhone, initials } from "@/lib/format";
import type { Courier } from "@/lib/types";

const STATUS: Record<Courier["status"], { dot: string; label: string; chip: string }> = {
  available: { dot: "bg-ok", label: "Libre", chip: "bg-ok-soft text-ok" },
  busy: { dot: "bg-gold", label: "En un viaje", chip: "bg-gold-soft text-gold-ink" },
  // Rojo: emergencia marcada por la central o novedad que reportó él (accidente, moto varada).
  paused: { dot: "bg-danger", label: "Emergencia", chip: "bg-danger-soft text-danger" },
  // Gris: recién agregado o desconectado. Se conecta escribiéndole al bot.
  offline: { dot: "bg-ink-3", label: "Desconectado", chip: "bg-sunken text-ink-3" },
};

export function CourierCard({
  courier,
  onChange,
  onEmergency,
  onRemove,
}: {
  courier: Courier;
  onChange: (next: Courier["status"]) => void;
  onEmergency: (on: boolean) => void;
  onRemove: () => void;
}) {
  const status = STATUS[courier.status];
  const located = courier.lat != null && courier.lng != null;
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const off = courier.status === "offline";
  const emergency = courier.status === "paused";
  const [confirmingEmergency, setConfirmingEmergency] = useState(false);
  // Con muchos motorizados la tarjeta se queda en el resumen; el resto se abre a pedido.
  const [expanded, setExpanded] = useState(false);

  return (
    <article className={`card flex flex-col gap-4 p-4 ${emergency ? "ring-2 ring-danger" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-clapi text-sm font-bold text-white">
          {initials(courier.name)}
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-[3px] ring-surface ${status.dot}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{courier.name}</p>
          <span className={`mt-0.5 inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${status.chip}`}>{status.label}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-sunken px-3 py-2">
          <p className="text-ink-3">Viajes hoy</p>
          <p className="text-base font-bold tabular-nums">{courier.deliveriesThisShift}</p>
        </div>
        {/* Dónde está ahora: abre su última posición en el mapa. */}
        <a
          href={located ? `https://www.google.com/maps?q=${courier.lat},${courier.lng}` : undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!located}
          className={`ease-ui flex flex-col justify-center rounded-xl px-3 py-2 ${
            located ? "bg-clapi-soft text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white" : "pointer-events-none bg-sunken text-ink-3"
          }`}
        >
          <span className="flex items-center gap-1 text-sm font-semibold">
            <LocateFixed size={14} /> {located ? "Ubicar" : "Sin ubicación"}
          </span>
          {located && courier.locationUpdatedAt && (
            <span className="text-[11px] opacity-80">hace {elapsedLabel(new Date(courier.locationUpdatedAt))}</span>
          )}
        </a>
      </div>

      {/* El número solo se copia: para el chat y la llamada están los botones de abajo. */}
      <button
        type="button"
        onClick={async () => {
          if (await copyText(formatPhone(courier.phone).replace(/\s/g, ""))) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        title="Copiar el número"
        className="ease-ui -my-1 flex items-center gap-1.5 self-start rounded-md py-1 text-xs text-ink-3 can-hover:hover:text-clapi-ink"
      >
        {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
        {copied ? "Copiado" : formatPhone(courier.phone)}
      </button>

      <div className="flex gap-2">
        {/* Donde estaba Activar / Pausar: abrir su chat en el portal o llamarlo. */}
        <PhoneLink phone={courier.phone} name={courier.name} iconOnly wide />
        <PhoneLink phone={courier.phone} name={courier.name} call iconOnly wide />
        {/* Encendido de ida y vuelta: verde si está conectado (tocar lo desconecta), apagado
            si no (tocar lo conecta). En un viaje o en emergencia no se toca. */}
        <button
          type="button"
          disabled={courier.status === "busy" || emergency}
          onClick={() => onChange(off ? "available" : "offline")}
          aria-label={off ? "Conectar" : "Desconectar"}
          title={off ? "Conectar" : "Desconectar"}
          className={`ease-ui flex h-10 w-10 items-center justify-center rounded-xl disabled:opacity-40 ${
            off
              ? "bg-sunken text-ink-3 can-hover:hover:bg-ok-soft can-hover:hover:text-ok"
              : "bg-ok-soft text-ok can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
          }`}
        >
          {off ? <PowerOff size={15} /> : <Power size={15} />}
        </button>
        <button
          type="button"
          onClick={() => (emergency ? onEmergency(false) : setConfirmingEmergency(true))}
          aria-label={emergency ? "Quitar la emergencia" : "Marcar emergencia"}
          title={emergency ? "Quitar la emergencia" : "Marcar emergencia"}
          className={`ease-ui flex h-10 w-10 items-center justify-center rounded-xl ${
            emergency ? "bg-danger text-white" : "bg-sunken text-ink-3 can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
          }`}
        >
          <Siren size={15} />
        </button>
        <button
          type="button"
          disabled={courier.status === "busy"}
          onClick={() => setConfirming(true)}
          aria-label="Quitar de la flota"
          className="ease-ui flex h-10 w-10 items-center justify-center rounded-xl bg-sunken text-ink-3 disabled:opacity-40 can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
        >
          <Trash2 size={15} />
        </button>
      </div>

      {emergency && (
        <p className="-mt-1 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
          No recibe pedidos y su bot está pausado.{" "}
          <Link href={chatHref(courier.phone)} className="font-semibold underline underline-offset-2">
            Abrir su chat
          </Link>
        </p>
      )}

      {confirmingEmergency && (
        <div role="alertdialog" aria-label={`Emergencia de ${courier.name}`} className="flex flex-col gap-2 rounded-xl bg-danger-soft p-3 text-xs text-danger">
          <p className="font-semibold">¿Marcar a {courier.name} en emergencia?</p>
          <ul className="list-disc pl-4 text-ink-2">
            <li>No le llegan más pedidos.</li>
            <li>El bot deja de responderle y su chat queda fijado arriba en Conversaciones.</li>
            <li>Lo que lleva sigue a su nombre: decide tú si reasignarlo.</li>
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirmingEmergency(false);
                onEmergency(true);
              }}
              className="ease-ui h-9 flex-1 rounded-lg bg-danger font-semibold text-white"
            >
              Sí, marcar emergencia
            </button>
            <button type="button" onClick={() => setConfirmingEmergency(false)} className="ease-ui h-9 rounded-lg bg-surface px-4 font-semibold text-ink-2">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div role="alertdialog" aria-label={`Quitar a ${courier.name}`} className="flex flex-col gap-2 rounded-xl bg-danger-soft p-3 text-xs text-danger">
          <p className="font-semibold">¿Quitar a {courier.name} de la flota?</p>
          <ul className="list-disc pl-4 text-ink-2">
            <li>Deja de recibir viajes desde ya.</li>
            <li>Si le escribe al bot, ya no lo reconoce como domiciliario.</li>
            <li>Sus viajes y su historial se conservan en los reportes.</li>
          </ul>
          <div className="flex gap-2">
            <button type="button" onClick={onRemove} className="ease-ui h-9 flex-1 rounded-lg bg-danger font-semibold text-white">
              Sí, quitarlo
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="ease-ui h-9 rounded-lg bg-surface px-4 font-semibold text-ink-2">
              Cancelar
            </button>
          </div>
        </div>
      )}

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
