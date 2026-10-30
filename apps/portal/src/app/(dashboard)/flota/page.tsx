"use client";

import { useCallback, useState } from "react";

import { AddCourierForm } from "@/components/AddCourierForm";
import { CourierCard } from "@/components/CourierCard";
import type { Courier } from "@/lib/types";
import { usePolling } from "@/lib/use-polling";

/** El mismo orden que usa la cola del servidor: nunca asignado primero,
 *  después el que hace más tiempo no recibe un viaje. */
function queueOrder(couriers: Courier[]) {
  return couriers
    .filter((c) => c.status === "available")
    .sort((a, b) => {
      if (!a.lastAssignedAt) return b.lastAssignedAt ? -1 : a.id - b.id;
      if (!b.lastAssignedAt) return 1;
      return a.lastAssignedAt.localeCompare(b.lastAssignedAt) || a.id - b.id;
    })
    .map((c) => c.id);
}

export default function FlotaPage() {
  const [couriers, setCouriers] = useState<Courier[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/couriers", { cache: "no-store" });
    if (res.ok) setCouriers(await res.json());
  }, []);

  usePolling(refresh, 3000);

  async function setStatus(id: number, status: Courier["status"]) {
    setCouriers((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
    await fetch(`/api/couriers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
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

  const queue = queueOrder(couriers);
  const counts = {
    available: couriers.filter((c) => c.status === "available").length,
    busy: couriers.filter((c) => c.status === "busy").length,
    off: couriers.filter((c) => c.status === "paused" || c.status === "offline").length,
  };
  const sorted = [...couriers].sort((a, b) => {
    const rank = (c: Courier) => (c.status === "available" ? queue.indexOf(c.id) : c.status === "busy" ? 100 : 200);
    return rank(a) - rank(b);
  });

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      {/* Sin título: arriba van los contadores y, a la derecha, agregar un motorizado. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* En celular ocupan la fila entera y el botón baja; desde tableta van lado a lado. */}
        <div className="grid w-full grid-cols-3 gap-2 sm:w-md sm:max-w-full">
          {[
            { label: "Libres", value: counts.available, dot: "bg-ok" },
            { label: "En viaje", value: counts.busy, dot: "bg-gold" },
            { label: "Fuera", value: counts.off, dot: "bg-danger" },
          ].map((s) => (
            <div key={s.label} className="card px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs text-ink-3">
                <span className={`h-2 w-2 rounded-full ${s.dot}`} /> {s.label}
              </p>
              <p className="text-xl font-bold tabular-nums">{s.value}</p>
            </div>
          ))}
        </div>
        <AddCourierForm onCreated={refresh} />
      </div>

      {/* `items-start`: abrir "Ver más" en una tarjeta no estira a sus vecinas de fila. */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {sorted.map((courier) => {
          const pos = queue.indexOf(courier.id);
          return (
            <CourierCard
              key={courier.id}
              courier={courier}
              queuePosition={pos >= 0 ? pos + 1 : null}
              onChange={(status) => setStatus(courier.id, status)}
              onRemove={() => remove(courier.id)}
            />
          );
        })}
        {couriers.length === 0 && (
          <p className="col-span-full py-12 text-center text-sm text-ink-3">Todavía no hay motorizados. Agrega el primero.</p>
        )}
      </div>
    </div>
  );
}
