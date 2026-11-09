"use client";

import { formatClock, type ServiceHours } from "@dispatch/shared/domain/service-hours";
import { Check, Clock } from "lucide-react";
import { useState } from "react";

const time =
  "ease-ui h-11 w-full min-w-0 rounded-xl bg-sunken px-3.5 text-sm outline-none focus:ring-2 focus:ring-clapi/40";

/**
 * El horario de Express: desde qué hora se reciben servicios (para todos) y la
 * hora límite de los restaurantes que no tienen una propia. El bot la aplica
 * desde el siguiente mensaje. Se muestra cuando ya se cargaron las horas.
 */
export function ServiceHoursCard({ hours, onSaved }: { hours: ServiceHours; onSaved: (hours: ServiceHours) => void }) {
  const [form, setForm] = useState<ServiceHours>(hours);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = form.opensAt !== hours.opensAt || form.defaultDeadline !== hours.defaultDeadline;

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/service-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      setError(data?.error ?? "No se pudo guardar. Intenta de nuevo.");
      return;
    }
    onSaved(await res.json());
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <section className="card flex flex-col gap-3 p-4 sm:p-5">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Clock size={16} className="text-clapi" /> Horario para pedir
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">Inicio de Express (todos los restaurantes)</span>
          <input type="time" value={form.opensAt} onChange={(e) => setForm({ ...form, opensAt: e.target.value })} className={time} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">Hora límite por defecto</span>
          <input
            type="time"
            value={form.defaultDeadline}
            onChange={(e) => setForm({ ...form, defaultDeadline: e.target.value })}
            className={time}
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving || !form.opensAt || !form.defaultDeadline}
          className="ease-ui flex h-11 items-center justify-center gap-2 rounded-xl bg-clapi px-5 text-sm font-semibold text-white shadow-sm disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
      <p className="text-xs text-ink-3">
        Se reciben servicios desde las {formatClock(hours.opensAt)} hasta la hora límite de cada restaurante; si no tiene una
        propia, hasta las {formatClock(hours.defaultDeadline)}. La hora límite puede pasar la medianoche (1:30 a. m. es esa
        misma noche). Fuera de horario el bot no recibe pedidos nuevos.
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && (
        <p className="flex items-center gap-1.5 text-sm text-ok">
          <Check size={16} /> Horario guardado
        </p>
      )}
    </section>
  );
}
