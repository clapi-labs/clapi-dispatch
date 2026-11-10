"use client";

import { signalState } from "@dispatch/shared/domain/gps";
import { isTripOpen, PHASE_LABEL, tripPhase } from "@dispatch/shared/domain/phase";
import { Check, ChevronDown, Copy, Eye, LocateFixed, Power, PowerOff, Siren, Trash2, WifiOff } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { CourierDetails } from "@/components/CourierDetails";
import { ConfirmDialog } from "@/components/Modal";
import { PhoneLink } from "@/components/PhoneLink";
import { PhotoButton } from "@/components/PhotoButton";
import { useTrips } from "@/components/TripsProvider";
import { chatHref } from "@/lib/chat";
import { copyText } from "@/lib/clipboard";
import { elapsedLabel, formatPhone, timeOfDay } from "@/lib/format";
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
  now,
  onChange,
  onEmergency,
  onRemove,
  onPhoto,
}: {
  courier: Courier;
  /** La hora con la que se calcula si la moto sigue «en vivo» (la página la avanza sola). */
  now: number;
  onChange: (next: Courier["status"]) => void;
  onEmergency: (on: boolean) => void;
  onRemove: () => void;
  onPhoto: (photo: string | null) => Promise<void>;
}) {
  const status = STATUS[courier.status];
  const { trips } = useTrips();
  // En un viaje, lo que importa es en qué va: se ve sin abrir «Ver más».
  const open = trips.filter((t) => t.courierId === courier.id && isTripOpen(t));
  const current = courier.status === "busy" ? open[open.length - 1] : undefined;
  const located = courier.lat != null && courier.lng != null;
  // En vivo, sin señal (con la hora de su última ubicación) o sin ubicación.
  const signal = signalState(courier, now);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const off = courier.status === "offline";
  const emergency = courier.status === "paused";
  const [confirmingEmergency, setConfirmingEmergency] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  // Con muchos motorizados la tarjeta se queda en el resumen; el resto se abre a pedido.
  const [expanded, setExpanded] = useState(false);

  return (
    <article className={`card flex flex-col gap-4 p-4 ${emergency ? "ring-2 ring-danger" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="relative h-12 w-12 shrink-0">
          <PhotoButton name={courier.name} photo={courier.photo} className="h-12 w-12 bg-clapi text-sm text-white" onChange={onPhoto} />
          <span
            className={`pointer-events-none absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-[3px] ring-surface ${status.dot}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{courier.name}</p>
          <span className={`mt-0.5 inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${status.chip}`}>
            {current ? `${PHASE_LABEL[tripPhase(current)]} · ${current.code}${open.length > 1 ? ` · +${open.length - 1}` : ""}` : status.label}
          </span>
          {courier.simulator && (
            <span className="ml-1.5 mt-0.5 inline-block rounded-md bg-clapi-soft px-2 py-0.5 text-xs font-semibold text-clapi-ink">
              {courier.simulator.role === "simulated"
                ? `🧪 Simulada${courier.simulator.partner ? ` · la controla ${courier.simulator.partner}` : ""}`
                : courier.simulator.role === "real"
                  ? "📡 Moto real con GPS · solo viajes de prueba"
                  : `🧪 Número de prueba${courier.simulator.partner ? ` · controla a ${courier.simulator.partner}` : " · libre"}`}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-sunken px-3 py-2">
          <p className="text-ink-3">Viajes hoy</p>
          <p className="text-base font-bold tabular-nums">{courier.deliveriesThisShift}</p>
        </div>
        {/* Dónde está ahora: en vivo o sin señal, y su última posición en el mapa. */}
        <a
          href={located ? `https://www.google.com/maps?q=${courier.lat},${courier.lng}` : undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!located}
          title={located ? "Abrir su última ubicación en el mapa" : undefined}
          className={`ease-ui flex flex-col justify-center rounded-xl px-3 py-2 ${
            !located
              ? "pointer-events-none bg-sunken text-ink-3"
              : signal === "live" && !off
                ? "bg-ok-soft text-ok can-hover:hover:bg-ok can-hover:hover:text-white"
                : signal === "lost" && !off
                  ? "bg-warn-soft text-warn can-hover:hover:bg-warn can-hover:hover:text-white"
                  : "bg-sunken text-ink-2 can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink"
          }`}
        >
          {!located ? (
            <>
              <span className="flex items-center gap-1 text-sm font-semibold">
                <LocateFixed size={14} /> Sin ubicación
              </span>
              <span className="text-[11px] opacity-80">{courier.hasGps ? "Su celular no ha reportado" : "GPS sin configurar"}</span>
            </>
          ) : off ? (
            <>
              <span className="flex items-center gap-1 text-sm font-semibold">
                <LocateFixed size={14} /> Última ubicación
              </span>
              {courier.locationUpdatedAt && <span className="text-[11px] opacity-80">{timeOfDay(courier.locationUpdatedAt)}</span>}
            </>
          ) : signal === "live" ? (
            <>
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <span className="h-2 w-2 animate-pulse rounded-full bg-ok" /> En vivo
              </span>
              {courier.locationUpdatedAt && (
                <span className="text-[11px] opacity-80">hace {elapsedLabel(new Date(courier.locationUpdatedAt), new Date(now))}</span>
              )}
            </>
          ) : (
            <>
              <span className="flex items-center gap-1 text-sm font-semibold">
                <WifiOff size={14} /> Sin señal
              </span>
              {courier.locationUpdatedAt && (
                <span className="text-[11px] opacity-80">
                  desde {timeOfDay(courier.locationUpdatedAt)} · hace {elapsedLabel(new Date(courier.locationUpdatedAt), new Date(now))}
                </span>
              )}
            </>
          )}
        </a>
      </div>

      {/* Cómo responde al mensaje: para exigirle al que siempre se demora en salir. */}
      {courier.seenStats && (
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3" title="Últimos 7 días">
          <Eye size={12} className="shrink-0" />
          {courier.seenStats.avgMinutes != null ? (
            <span>
              Confirma en <strong className={courier.seenStats.avgMinutes > 3 ? "text-danger" : "text-ink-2"}>{courier.seenStats.avgMinutes} min</strong> en
              promedio ({courier.seenStats.confirmed} {courier.seenStats.confirmed === 1 ? "pedido" : "pedidos"})
            </span>
          ) : (
            <span>Sin confirmaciones</span>
          )}
          {courier.seenStats.reminders > 0 && (
            <span className="text-warn">
              · {courier.seenStats.reminders} {courier.seenStats.reminders === 1 ? "recordatorio" : "recordatorios"}
            </span>
          )}
          <span>· 7 días</span>
        </p>
      )}

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
            si no (tocar lo conecta). En emergencia no se toca. */}
        <button
          type="button"
          disabled={emergency}
          onClick={() => (off ? onChange("available") : setConfirmingOff(true))}
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

      {confirmingOff && (
        <ConfirmDialog
          title={`¿Desconectar a ${courier.name}?`}
          points={[
            "No le llegan más pedidos.",
            ...(open.length ? ["Lo que no ha recogido se asigna a otra moto y termina lo que ya lleva."] : []),
            "Vuelve a conectarse cuando le escriba al bot, o tocando aquí el mismo botón.",
          ]}
          confirmLabel="Sí, desconectar"
          onConfirm={() => onChange("offline")}
          onClose={() => setConfirmingOff(false)}
        />
      )}

      {confirmingEmergency && (
        <ConfirmDialog
          title={`¿Marcar a ${courier.name} en emergencia?`}
          points={[
            "No le llegan más pedidos.",
            "El bot deja de responderle y su chat queda fijado arriba en Conversaciones.",
            "Lo que lleva sigue a su nombre: decide tú si reasignarlo.",
          ]}
          confirmLabel="Sí, marcar"
          onConfirm={() => onEmergency(true)}
          onClose={() => setConfirmingEmergency(false)}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={`¿Quitar a ${courier.name} de la flota?`}
          points={[
            "Deja de recibir viajes desde ya.",
            "Si le escribe al bot, ya no lo reconoce como domiciliario.",
            "Sus viajes y su historial se conservan en los reportes.",
          ]}
          confirmLabel="Sí, quitarlo"
          onConfirm={onRemove}
          onClose={() => setConfirming(false)}
        />
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
