"use client";

import { isBeforePickup, PHASE_LABEL, phaseSince, tripPhase, type TripPhase } from "@dispatch/shared/domain/phase";
import { ArrowRightLeft, Bike, Check, CheckCircle2, ChevronDown, CornerDownLeft } from "lucide-react";
import { motion } from "motion/react";
import { memo, useState, type MouseEvent } from "react";

import { AssignDialog } from "@/components/AssignDialog";
import { ConfirmDialog, Modal } from "@/components/Modal";
import { PhoneLink } from "@/components/PhoneLink";
import type { DeliveryOutcome } from "@/components/TripsProvider";
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
        {at ? at.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "Finalizado"}
      </span>
    );
  }
  return null;
}

const PHASE_TONE: Record<TripPhase, string> = {
  pending: "bg-warn-soft text-warn",
  unread: "bg-warn-soft text-warn",
  read: "bg-warn-soft text-warn",
  going: "bg-clapi-soft text-clapi-ink",
  at_pickup: "bg-clapi-soft text-clapi-ink",
  carrying: "bg-clapi-soft text-clapi-ink",
  at_delivery: "bg-clapi-soft text-clapi-ink",
  waiting_customer: "bg-warn-soft text-warn",
  undelivered: "bg-warn-soft text-warn",
  returning: "bg-gold-soft text-gold-ink",
  delivered: "bg-ok-soft text-ok",
  // Resalta: es lo que el restaurante tiene que avisarle a su cliente.
  gate: "bg-gold-soft text-gold-ink",
  cancelled: "bg-sunken text-ink-3",
};

/**
 * En qué va el servicio y hace cuánto (docs/FLUJO-DOMICILIARIO.md). En rojo
 * pasado el tiempo de esa fase, para que la central lo llame o le pase el pedido
 * a otra moto; «recordado» si el bot ya le insistió.
 */
function PhaseBadge({ trip, alert }: { trip: Trip; alert: boolean }) {
  const phase = tripPhase(trip);
  const since = phaseSince(trip);
  const closed = phase === "delivered" || phase === "gate";
  // Alcanza con cada 20 s: muestra minutos. Lo cerrado no cambia.
  const now = useNow(closed ? null : 20_000);
  const min = since && !closed ? Math.max(0, Math.floor((now - since.getTime()) / 60_000)) : null;
  const reminded = (phase === "unread" || phase === "read" ? trip.seenReminderAt : phase === "going" || phase === "at_pickup" ? trip.pickupReminderAt : null) ? " · recordado" : "";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${alert ? "bg-danger text-white" : PHASE_TONE[phase]}`}>
      {PHASE_LABEL[phase]}
      {/* Mientras vuelve no se pierde dónde quedó el pedido. */}
      {phase === "returning" && trip.deliveryPlace === "gate" ? " · dejó en portería" : ""}
      {phase === "carrying" && trip.leftDeliveryAt ? " · se fue sin marcar la entrega" : ""}
      {min !== null ? ` · ${min} min` : ""}
      {reminded}
    </span>
  );
}

const OUTCOMES: { label: string; outcome: DeliveryOutcome }[] = [
  { label: "Entregado, terminó", outcome: { place: "customer", returning: false } },
  { label: "Entregado, vuelve a recogida", outcome: { place: "customer", returning: true } },
  { label: "En portería, terminó", outcome: { place: "gate", returning: false } },
  { label: "En portería, vuelve a recogida", outcome: { place: "gate", returning: true } },
];

/** Las mismas opciones que tiene el motorizado en WhatsApp, para cuando no pudo
 *  marcarlo él. */
function DeliverDialog({ code, onChoose, onClose }: { code: string; onChoose: (outcome: DeliveryOutcome) => void; onClose: () => void }) {
  return (
    <Modal label={`Marcar entrega de ${code}`} onClose={onClose}>
      <p className="text-base font-semibold text-ink">¿Cómo quedó {code}?</p>
      <div className="flex flex-col gap-2">
        {OUTCOMES.map(({ label, outcome }) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              onClose();
              onChoose(outcome);
            }}
            className="ease-ui h-11 rounded-xl bg-clapi-soft px-3 text-left text-sm font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
          >
            {label}
          </button>
        ))}
      </div>
      <button type="button" onClick={onClose} className="ease-ui h-10 rounded-xl bg-sunken text-sm font-semibold text-ink-2">
        Cancelar
      </button>
    </Modal>
  );
}

/**
 * La tarjeta no depende del reloj: solo el cronómetro (`Timer`) late cada
 * segundo. Antes la tarjeta entera, con su animación de `layout`, se volvía a
 * medir y dibujar cada segundo por cada viaje en pantalla. `memo`: si el viaje
 * no cambió, una actualización del tablero tampoco la toca.
 */
/** «+2.000» o «−1.000»: el signo siempre a la vista. */
function signedCOP(n: number) {
  return `${n < 0 ? "−" : "+"}${formatCOP(Math.abs(n))}`;
}

/**
 * De dónde sale el precio, para explicárselo a un restaurante: los km, lo de
 * la tabla por km y el ajuste de la zona de la entrega. Lo ve solo la
 * central; el restaurante solo ve el total.
 */
function FareDetail({ trip }: { trip: Trip }) {
  const km = trip.distanceKm != null ? `${trip.distanceKm.toLocaleString("es-CO", { maximumFractionDigits: 1 })} km${trip.routeSource === "calle" ? " por calle" : trip.routeSource === "linea_recta" ? " en línea recta" : ""}` : null;
  const split = trip.fareTablePrice != null;
  return (
    <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-xl bg-sunken px-3 py-2 text-xs tabular-nums">
      {km && (
        <>
          <dt className="text-ink-3">Distancia</dt>
          <dd className="text-right">{km}</dd>
        </>
      )}
      {split ? (
        <>
          <dt className="text-ink-3">Tabla por km</dt>
          <dd className="text-right">{formatCOP(trip.fareTablePrice!)}</dd>
          <dt className="text-ink-3">{trip.fareZoneName ? `Zona ${trip.fareZoneName}` : "Ajuste de zona"}</dt>
          <dd className="text-right">{trip.fareAdjustment ? signedCOP(trip.fareAdjustment) : "sin ajuste"}</dd>
        </>
      ) : (
        <>
          <dt className="text-ink-3">Precio</dt>
          <dd className="text-right text-ink-3">sin desglose (lo puso la central o es de antes)</dd>
        </>
      )}
      <dt className="font-semibold">Total</dt>
      <dd className="text-right font-semibold">{formatCOP(trip.deliveryFee)}</dd>
    </dl>
  );
}

export const TripCard = memo(function TripCard({
  trip,
  focused = false,
  onDeliver,
  onFinish,
  onAssign,
}: {
  trip: Trip;
  /** Se llegó a él desde una alerta del celular: se marca un momento. */
  focused?: boolean;
  onDeliver: (id: number, outcome: DeliveryOutcome) => void;
  onFinish: (id: number) => void;
  onAssign: (id: number, courierId: number | null) => Promise<boolean>;
}) {
  // Si el engine lo está aguantando a propósito, cuenta desde la hora de despachar.
  const urgent = useAfter(trip.status === "pending" ? Math.max(Date.parse(trip.createdAt), trip.dispatchAt ? Date.parse(trip.dispatchAt) : 0) + 120_000 : null);
  const assignedFor8s = useAfter(trip.status === "en_route" && trip.assignedAt ? Date.parse(trip.assignedAt) + 8000 : null);
  const justAssigned = trip.status === "en_route" && trip.assignedAt !== null && !assignedFor8s;
  const [open, setOpen] = useState(false);
  const [confirmingDeliver, setConfirmingDeliver] = useState(false);
  const [confirmingBack, setConfirmingBack] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const returning = tripPhase(trip) === "returning";
  const phaseAlert = useAfter(trip.alertAt ? Date.parse(trip.alertAt) : null);
  const tag = [trip.distanceKm != null && `${Math.max(1, Math.round(trip.distanceKm))} km`, trip.deliveryFee > 0 && formatCOP(trip.deliveryFee)].filter(Boolean).join(" · ");

  // Toda la tarjeta abre el detalle, menos sus botones y enlaces, que hacen lo suyo.
  function toggle(e: MouseEvent) {
    if (!(e.target as HTMLElement).closest("a, button")) setOpen((v) => !v);
  }

  return (
    <motion.article
      layout="position"
      layoutId={`trip-${trip.id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      id={`pedido-${trip.id}`}
      onClick={toggle}
      className={`card flex cursor-pointer flex-col gap-2.5 p-3.5 ${urgent || phaseAlert ? "animate-urgent" : ""} ${justAssigned ? "animate-assigned" : ""} ${
        focused ? "ring-2 ring-clapi ring-offset-2 ring-offset-canvas" : ""
      }`}
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

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ink-3">
          {tag && <span className="rounded-full bg-gold px-2.5 py-0.5 text-xs font-bold tabular-nums text-clapi-deep">{tag}</span>}
          <PhaseBadge trip={trip} alert={phaseAlert} />
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Ocultar información adicional" : "Ver información adicional"}
          className="ease-ui flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 can-hover:hover:bg-clapi-soft"
        >
          <ChevronDown size={16} className={`ease-ui ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Se abre con CSS y no con `motion`: solo crece este bloque y lo de abajo baja, nada más se reacomoda. */}
      <div
        inert={!open}
        className={`-mt-2.5 grid transition-[grid-template-rows,opacity] duration-200 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col items-start gap-2 pt-2.5">
            {trip.deliveryFee > 0 && <FareDetail trip={trip} />}
            {/* Las indicaciones que el bot sacó del pedido: referencias del lugar, con cuánto paga, etc. */}
            {trip.notes && <p className="text-xs leading-snug text-ink">{trip.notes}</p>}
            {/* El cliente final no tiene chat con el bot: su número solo llama. */}
            {trip.customerPhone && <PhoneLink phone={trip.customerPhone} name="Cliente" pill call />}
            {!trip.notes && !trip.customerPhone && trip.deliveryFee <= 0 && <span className="rounded-full bg-sunken px-2.5 py-0.5 text-xs text-ink-3">Sin información adicional</span>}
            {/* Con el pedido en la mano ya no: eso lo arregla la central hablando con él. */}
            {trip.status === "en_route" && isBeforePickup(tripPhase(trip)) && (
              <button
                type="button"
                onClick={() => setAssigning(true)}
                className="ease-ui flex h-8 items-center gap-1.5 rounded-xl bg-sunken px-3 text-xs font-semibold text-ink-2 can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink"
              >
                <ArrowRightLeft size={13} /> Pasar a otra moto
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Una sola línea: avatar, nombre, chat y llamada; al final, lo que le falta marcar. */}
      <footer className="flex items-center gap-2 border-t border-gray-100 pt-2.5">
        {trip.courierName ? (
          <>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-clapi lg:h-8 lg:w-8 text-[11px] font-bold text-white">
              {initials(trip.courierName)}
            </span>
            <p className="min-w-0 wrap-break-word text-xs font-medium leading-tight">{trip.courierName}</p>
            {/* Del motorizado no se muestra el número: un botón abre su chat y el otro lo llama. */}
            {trip.courierPhone && (
              <div className="flex shrink-0 items-center gap-1.5 text-ink-3">
                <PhoneLink phone={trip.courierPhone} name={trip.courierName} iconOnly className="h-9! w-9! lg:h-8! lg:w-8!" />
                <PhoneLink phone={trip.courierPhone} name={trip.courierName} call iconOnly className="h-9! w-9! lg:h-8! lg:w-8!" />
              </div>
            )}
          </>
        ) : (
          <div className="flex min-w-0 items-center gap-2 text-xs leading-tight text-ink-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed lg:h-8 lg:w-8 border-ink-3/40">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
            </span>
            {trip.dispatchNote ?? "Buscando moto libre…"}
          </div>
        )}

        {trip.status === "pending" && (
          <button
            type="button"
            onClick={() => setAssigning(true)}
            className="ease-ui ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-clapi-soft px-3 text-xs font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
          >
            <Bike size={14} />
            Asignar
          </button>
        )}

        {trip.status === "en_route" && (
          <button
            type="button"
            onClick={() => setConfirmingDeliver(true)}
            className="ease-ui ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-clapi-soft px-3 text-xs font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
          >
            <Check size={14} />
            Entregado
          </button>
        )}
        {returning && (
          <button
            type="button"
            onClick={() => setConfirmingBack(true)}
            className="ease-ui ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-clapi-soft px-3 text-xs font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
          >
            <CornerDownLeft size={14} />
            Ya volvió
          </button>
        )}
      </footer>

      {confirmingDeliver && <DeliverDialog code={trip.code} onChoose={(outcome) => onDeliver(trip.id, outcome)} onClose={() => setConfirmingDeliver(false)} />}

      {assigning && <AssignDialog trip={trip} onAssign={(courierId) => onAssign(trip.id, courierId)} onClose={() => setAssigning(false)} />}

      {confirmingBack && (
        <ConfirmDialog
          title={`¿${trip.courierName ?? "El domiciliario"} ya volvió?`}
          points={["Termina el servicio y queda libre si no lleva otro."]}
          confirmLabel="Sí, ya volvió"
          tone="primary"
          onConfirm={() => onFinish(trip.id)}
          onClose={() => setConfirmingBack(false)}
        />
      )}
    </motion.article>
  );
});
