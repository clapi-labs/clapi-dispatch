"use client";

import { signalState } from "@dispatch/shared/domain/gps";
import { List, Map as MapIcon, Search } from "lucide-react";
import { useCallback, useState } from "react";

import { AddCourierForm } from "@/components/AddCourierForm";
import { CourierCard } from "@/components/CourierCard";
import { FleetMap } from "@/components/FleetMap";
import type { Courier } from "@/lib/types";
import { useLive } from "@/lib/live";
import { useNow } from "@/lib/use-now";

type Filter = "available" | "busy" | "offline" | "paused";

const FILTERS: { key: Filter; label: string; dot: string }[] = [
  { key: "available", label: "Libres", dot: "bg-ok" },
  { key: "busy", label: "En viaje", dot: "bg-gold" },
  { key: "offline", label: "Desconectados", dot: "bg-ink-3" },
  { key: "paused", label: "Emergencia", dot: "bg-danger" },
];

export default function FlotaPage() {
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter | null>(null);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<"list" | "map">("list");
  // Perder la señal no cambia nada en la base: el paso a «sin señal» lo marca
  // este reloj, a los pocos segundos de cumplirse los 30 sin reporte.
  const now = useNow(3000);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/couriers", { cache: "no-store" });
    if (res.ok) setCouriers(await res.json());
  }, []);

  // Estado, turno y última asignación cambian con la moto o con sus viajes.
  useLive(refresh, ["couriers", "assignments", "trips"]);

  async function setStatus(id: number, status: Courier["status"]) {
    setCouriers((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
    await fetch(`/api/couriers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    refresh();
  }

  async function setEmergency(id: number, on: boolean) {
    setCouriers((prev) => prev.map((c) => (c.id === id ? { ...c, status: on ? "paused" : c.status } : c)));
    await fetch(`/api/couriers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emergency: on }),
    });
    refresh();
  }

  async function remove(id: number) {
    setCouriers((prev) => prev.filter((c) => c.id !== id));
    await fetch(`/api/couriers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    refresh();
  }

  async function setPhoto(id: number, photo: string | null) {
    const res = await fetch(`/api/couriers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo }),
    });
    if (!res.ok) throw new Error("No se guardó");
    setCouriers((prev) => prev.map((c) => (c.id === id ? { ...c, photo } : c)));
  }

  // Señal de las conectadas: las desconectadas no reportan ni se esperan.
  const connected = couriers.filter((c) => c.status !== "offline");
  const live = connected.filter((c) => signalState(c, now) === "live").length;
  const lost = connected.filter((c) => signalState(c, now) === "lost").length;

  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, couriers.filter((c) => c.status === f.key).length])) as Record<Filter, number>;
  const needle = query.trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  // Por nombre, sin importar el estado: una tarjeta no se mueve cuando su estado cambia.
  const shown = couriers
    .filter((c) => !filter || c.status === filter)
    .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (digits !== "" && c.phone.includes(digits)))
    .sort((a, b) => a.name.localeCompare(b.name, "es") || a.id - b.id);

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      {/* Una sola pieza: cuántos hay en cada estado, que también filtra, y la barra de abajo reparte la flota. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="card overflow-hidden lg:w-xl lg:shrink-0">
          <div className="grid grid-cols-4 divide-x divide-line">
            {FILTERS.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={filter === s.key}
                onClick={() => setFilter(filter === s.key ? null : s.key)}
                className={`ease-ui flex min-w-0 flex-col items-center gap-0.5 px-1 py-2 active:bg-clapi-soft ${filter === s.key ? "bg-clapi-soft" : "can-hover:hover:bg-sunken"}`}
              >
                <span className="flex items-center gap-1.5 text-lg font-bold leading-tight tabular-nums">
                  <span className={`h-2 w-2 rounded-full ${s.dot}`} />
                  {counts[s.key]}
                </span>
                <span className={`text-[10px] tracking-tight xs:text-[11px] ${filter === s.key ? "font-semibold text-clapi-ink" : "text-ink-3"}`}>{s.label}</span>
              </button>
            ))}
          </div>
          <div className="flex h-1 bg-sunken">
            {FILTERS.map((s) => (
              <span key={s.key} className={`ease-ui ${s.dot}`} style={{ flexGrow: counts[s.key] }} />
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <label className="ease-ui flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl bg-sunken px-3.5 focus-within:ring-2 focus-within:ring-clapi/30">
            <Search size={16} className="shrink-0 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearching(true)}
              onBlur={() => setSearching(false)}
              placeholder="Buscar por nombre o número"
              className="w-full min-w-0 bg-transparent text-sm outline-none"
            />
          </label>
          <AddCourierForm collapsed={searching || query !== ""} onCreated={refresh} />
        </div>
      </div>

      {/* Señal de GPS de las conectadas, y lista o mapa. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-ok" /> <strong className="tabular-nums">{live}</strong> en vivo
          </span>
          <span className={`flex items-center gap-1.5 ${lost ? "text-warn" : ""}`}>
            <span className={`h-2 w-2 rounded-full ${lost ? "bg-warn" : "bg-ink-3"}`} /> <strong className="tabular-nums">{lost}</strong> sin señal
          </span>
          {connected.length - live - lost > 0 && (
            <span className="text-ink-3">
              <strong className="tabular-nums">{connected.length - live - lost}</strong> conectadas sin ubicación
            </span>
          )}
        </p>
        <div className="flex rounded-xl bg-sunken p-1 text-sm font-semibold" role="group" aria-label="Vista">
          {(
            [
              { key: "list", label: "Lista", Icon: List },
              { key: "map", label: "Mapa", Icon: MapIcon },
            ] as const
          ).map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={`ease-ui flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${view === key ? "bg-surface text-clapi-ink shadow-sm" : "text-ink-3 can-hover:hover:text-ink-2"}`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>

      {view === "map" && <FleetMap couriers={shown} now={now} />}

      {/* `items-start`: abrir "Ver más" en una tarjeta no estira a sus vecinas de fila. */}
      <div className={`grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 ${view === "map" ? "hidden" : ""}`}>
        {shown.map((courier) => (
          <CourierCard
            key={courier.id}
            courier={courier}
            now={now}
            onChange={(status) => setStatus(courier.id, status)}
            onEmergency={(on) => setEmergency(courier.id, on)}
            onRemove={() => remove(courier.id)}
            onPhoto={(photo) => setPhoto(courier.id, photo)}
          />
        ))}
        {couriers.length > 0 && shown.length === 0 && <p className="col-span-full py-12 text-center text-sm text-ink-3">Ninguno coincide.</p>}
        {couriers.length === 0 && (
          <p className="col-span-full py-12 text-center text-sm text-ink-3">Todavía no hay motorizados. Agrega el primero.</p>
        )}
      </div>
    </div>
  );
}
