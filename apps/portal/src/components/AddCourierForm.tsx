"use client";

import { UserPlus, X } from "lucide-react";
import { useState } from "react";

import { CITY_CENTER } from "@/lib/geo";

export function AddCourierForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !phone.trim()) return;
    setBusy(true);
    // Posición aproximada de arranque; la real la reporta su app.
    const jitter = () => (Math.random() - 0.5) * 0.06;
    await fetch("/api/couriers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phone, lat: CITY_CENTER.lat + jitter(), lng: CITY_CENTER.lng + jitter() }),
    });
    setName("");
    setPhone("");
    setBusy(false);
    setOpen(false);
    onCreated();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ease-ui flex h-11 items-center gap-2 rounded-xl bg-clapi px-4 text-sm font-semibold text-white shadow-sm can-hover:hover:brightness-110"
      >
        <UserPlus size={17} /> Agregar motorizado
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="card flex w-full flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nombre completo"
        className="ease-ui h-11 min-w-0 flex-1 rounded-xl bg-sunken px-3.5 outline-none focus:ring-2 focus:ring-clapi/40"
      />
      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        inputMode="tel"
        placeholder="Celular (3001234567)"
        className="ease-ui h-11 rounded-xl bg-sunken px-3.5 outline-none focus:ring-2 focus:ring-clapi/40 sm:w-56"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim() || !phone.trim()}
          className="ease-ui h-11 flex-1 rounded-xl bg-clapi px-5 text-sm font-semibold text-white disabled:opacity-50 sm:flex-none"
        >
          Guardar
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Cancelar"
          className="flex h-11 w-11 items-center justify-center rounded-xl bg-sunken text-ink-3"
        >
          <X size={18} />
        </button>
      </div>
    </form>
  );
}
