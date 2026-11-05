"use client";

import { Search } from "lucide-react";
import { useCallback, useState } from "react";

import { AddCourierForm } from "@/components/AddCourierForm";
import { CourierCard } from "@/components/CourierCard";
import type { Courier } from "@/lib/types";
import { useLive } from "@/lib/live";

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

      {/* `items-start`: abrir "Ver más" en una tarjeta no estira a sus vecinas de fila. */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {shown.map((courier) => (
          <CourierCard
            key={courier.id}
            courier={courier}
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
