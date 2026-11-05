"use client";

import { UserPlus } from "lucide-react";
import { useState } from "react";

import { Modal } from "@/components/Modal";
import { CITY_CENTER } from "@/lib/geo";

export function AddCourierForm({ collapsed, onCreated }: { collapsed: boolean; onCreated: () => void }) {
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

  return (
    <>
      {/* Mientras se busca queda solo el ícono, y el buscador se queda con el espacio. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Agregar motorizado"
        title="Agregar motorizado"
        className="ease-ui flex h-11 shrink-0 items-center rounded-xl bg-clapi px-3.5 text-sm font-semibold text-white shadow-sm can-hover:hover:brightness-110"
      >
        <UserPlus size={17} className="shrink-0" />
        <span className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ease-out ${collapsed ? "max-w-0 opacity-0" : "ml-2 max-w-24 opacity-100"}`}>Agregar</span>
      </button>

      {open && (
        <Modal label="Agregar motorizado" onClose={() => setOpen(false)}>
          <p className="text-base font-semibold text-ink">Agregar motorizado</p>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre completo"
              className="ease-ui h-11 rounded-xl bg-sunken px-3.5 text-sm outline-none focus:ring-2 focus:ring-clapi/40"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              placeholder="Celular (3001234567)"
              className="ease-ui h-11 rounded-xl bg-sunken px-3.5 text-sm outline-none focus:ring-2 focus:ring-clapi/40"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className="ease-ui h-10 flex-1 rounded-xl bg-sunken text-sm font-semibold text-ink-2">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim() || !phone.trim()}
                className="ease-ui h-10 flex-1 rounded-xl bg-clapi text-sm font-semibold text-white disabled:opacity-50"
              >
                Guardar
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
