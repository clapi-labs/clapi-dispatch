"use client";

import { Bot, Inbox } from "lucide-react";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { useState } from "react";

import { TripCard } from "@/components/TripCard";
import { useTrips } from "@/components/TripsProvider";
import type { Trip } from "@/lib/types";

type ColumnKey = "pending" | "route" | "done";

const COLUMNS: { key: ColumnKey; title: string; dot: string; empty: string }[] = [
  { key: "pending", title: "Por asignar", dot: "bg-warn", empty: "Nada esperando moto" },
  { key: "route", title: "En ruta", dot: "bg-clapi", empty: "Ninguna moto en la calle" },
  { key: "done", title: "Entregados", dot: "bg-ok", empty: "Todavía no hay entregas hoy" },
];

function bucket(trips: Trip[], key: ColumnKey) {
  if (key === "pending") return trips.filter((t) => t.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (key === "route")
    return trips
      .filter((t) => t.status === "en_route" || t.status === "assigned")
      .sort((a, b) => (b.assignedAt ?? "").localeCompare(a.assignedAt ?? ""));
  return trips
    .filter((t) => t.status === "delivered")
    .sort((a, b) => (b.deliveredAt ?? b.updatedAt).localeCompare(a.deliveredAt ?? a.updatedAt));
}

function SkeletonCard() {
  return <div className="card h-48 animate-pulse bg-surface" />;
}

export default function ViajesPage() {
  const { trips, loaded, online, deliver } = useTrips();
  // En el celular se ve una columna a la vez. Arranca en "En ruta": es lo
  // que el despachador vigila — lo pendiente se asigna solo.
  const [tab, setTab] = useState<ColumnKey>("route");

  const groups = Object.fromEntries(COLUMNS.map((c) => [c.key, bucket(trips, c.key)])) as Record<ColumnKey, Trip[]>;

  return (
    <div className="mx-auto flex h-full max-w-[1500px] flex-col gap-5 px-4 py-5 lg:gap-4 lg:px-8 lg:py-7">
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight lg:text-2xl">Despachos</h1>
          <p className="text-sm text-ink-3">
            {groups.route.length} en la calle · {groups.done.length} entregados hoy
          </p>
        </div>
        {/* El robot dice de quién se habla: es el bot el que está en vivo o caído. */}
        <span
          role="status"
          className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold ${
            online ? "bg-clapi-soft text-clapi-ink" : "bg-danger-soft text-danger"
          }`}
        >
          <Bot size={16} />
          {online ? "En vivo" : "Sin conexión"}
          <span className={`h-2 w-2 rounded-full ${online ? "animate-live bg-ok" : "bg-danger"}`} />
        </span>
      </div>

      {/* Celular: control segmentado. Escritorio: no hace falta, se ven las tres.
          Cada pestaña toma el ancho de su texto, no un tercio fijo. En celulares angostos
          se va el punto y baja la letra: así caben las tres sin partirse ni salirse. */}
      <div className="flex gap-1 rounded-xl bg-sunken p-1 xs:gap-2 lg:hidden">
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setTab(c.key)}
            className={`ease-ui flex h-10 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold xs:text-xs sm:px-3 ${
              tab === c.key ? "bg-surface text-clapi-ink shadow-sm" : "text-ink-3"
            }`}
          >
            <span className={`hidden h-1.5 w-1.5 shrink-0 rounded-full xs:block ${c.dot}`} />
            <span className="truncate">{c.title}</span>
            <span className="shrink-0 tabular-nums text-ink-3">{groups[c.key].length}</span>
          </button>
        ))}
      </div>

      <LayoutGroup>
        <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-3">
          {COLUMNS.map((c) => {
            const empty = loaded && groups[c.key].length === 0;
            return (
              // `min-w-0`: en el celular la columna no puede ensancharse por un nombre largo.
              <section key={c.key} className={`min-h-0 min-w-0 flex-col gap-3 ${tab === c.key ? "flex" : "hidden lg:flex"}`}>
                <div className="hidden items-center gap-2 px-1 lg:flex">
                  <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                  <h2 className="text-sm font-semibold">{c.title}</h2>
                  <span className="rounded-full bg-clapi-soft px-2 py-0.5 text-xs font-semibold tabular-nums text-clapi-ink">{groups[c.key].length}</span>
                </div>

                {/* Las tarjetas van directo sobre el fondo del tablero. El margen negativo le deja
                    aire al anillo de urgente, que el scroll recortaría. Vacía, la columna no se estira. */}
                <div
                  className={`no-scrollbar flex flex-col gap-3 ${
                    empty ? "" : "lg:-mx-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-2 lg:pb-2 lg:pt-0.5"
                  }`}
                >
                  {!loaded ? (
                    <>
                      <SkeletonCard />
                      <SkeletonCard />
                    </>
                  ) : (
                    <AnimatePresence mode="popLayout" initial={false}>
                      {groups[c.key].map((trip) => (
                        <TripCard key={trip.id} trip={trip} onDeliver={deliver} />
                      ))}
                    </AnimatePresence>
                  )}
                  {empty && (
                    <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-clapi-soft bg-surface/60 px-4 py-5 text-center text-sm text-ink-3 backdrop-blur-sm">
                      <Inbox size={18} className="shrink-0 text-clapi/50" />
                      {c.empty}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </LayoutGroup>
    </div>
  );
}
