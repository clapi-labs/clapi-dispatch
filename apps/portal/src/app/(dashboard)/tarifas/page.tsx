"use client";

import { Check, Info, MapPinned, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatCOP } from "@/lib/format";
import type { FareMatrix } from "@/lib/types";

const key = (o: number, d: number) => `${o}-${d}`;

/**
 * Configuración de tarifas: la matriz zona de recogida × zona de entrega.
 * Cada celda se edita en el sitio; nada se guarda hasta "Guardar", así un
 * dedo que se resbala en el celular no cambia un precio de verdad.
 */
export default function TarifasPage() {
  const [matrix, setMatrix] = useState<FareMatrix | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [defaultFare, setDefaultFare] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/fares", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: FareMatrix) => {
        setMatrix(data);
        setPrices(Object.fromEntries(data.fares.map((f) => [key(f.originZoneId, f.destinationZoneId), String(f.price)])));
        setDefaultFare(String(data.defaultFare));
      });
  }, []);

  const dirty = useMemo(() => {
    if (!matrix) return false;
    const original = Object.fromEntries(matrix.fares.map((f) => [key(f.originZoneId, f.destinationZoneId), String(f.price)]));
    return Object.entries(prices).some(([k, v]) => original[k] !== v) || String(matrix.defaultFare) !== defaultFare;
  }, [matrix, prices, defaultFare]);

  async function save() {
    if (!matrix) return;
    setSaving(true);
    const fares = matrix.zones.flatMap((o) =>
      matrix.zones
        .map((d) => ({ originZoneId: o.id, destinationZoneId: d.id, price: parseInt(prices[key(o.id, d.id)] ?? "", 10) }))
        .filter((f) => Number.isInteger(f.price)),
    );
    const fallback = parseInt(defaultFare, 10) || 0;
    await fetch("/api/fares", { method: "PUT", body: JSON.stringify({ fares, defaultFare: fallback }) });
    setMatrix({ ...matrix, fares, defaultFare: fallback });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  const zones = matrix?.zones ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight lg:text-2xl">Configuración de tarifas</h1>
          <p className="text-sm text-ink-3">Precio del domicilio según dónde se recoge y dónde se entrega</p>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="ease-ui flex h-11 items-center gap-2 rounded-xl bg-clapi px-5 text-sm font-semibold text-white shadow-sm disabled:opacity-40"
        >
          {saved ? <Check size={17} /> : null}
          {saving ? "Guardando…" : saved ? "Guardado" : "Guardar cambios"}
        </button>
      </div>

      <div className="flex gap-3 rounded-2xl bg-clapi-soft p-4 text-sm text-clapi-ink">
        <Sparkles size={18} className="mt-0.5 shrink-0 fill-clapi text-clapi" />
        <p>
          <strong>El bot reconoce el barrio solo.</strong> Cuando un restaurante escribe <em>“recoger cra 119, Caney — entregar calle 18,
          Valle del Lili”</em>, el sistema identifica las dos zonas y cobra el precio de esta tabla — sin que nadie lo calcule a mano.
        </p>
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
          <MapPinned size={16} className="text-clapi" /> Matriz de precios
          <span className="ml-auto text-xs font-normal text-ink-3">Filas: recoge · Columnas: entrega</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-sunken px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                  Recoge ↓ / Entrega →
                </th>
                {zones.map((z) => (
                  <th key={z.id} className="bg-sunken px-2 py-3 text-center text-xs font-semibold text-ink-2">
                    {z.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {zones.map((origin) => (
                <tr key={origin.id} className="border-t border-line">
                  <th className="sticky left-0 z-10 bg-surface px-4 py-2 text-left text-sm font-semibold">{origin.name}</th>
                  {zones.map((dest) => {
                    const k = key(origin.id, dest.id);
                    const same = origin.id === dest.id;
                    return (
                      <td key={dest.id} className={`px-1.5 py-1.5 text-center ${same ? "bg-clapi-soft/40" : ""}`}>
                        <label className="ease-ui flex h-11 items-center justify-center rounded-lg ring-1 ring-transparent focus-within:bg-surface focus-within:ring-clapi/50 can-hover:hover:bg-sunken">
                          <span className="text-xs text-ink-3">$</span>
                          <input
                            inputMode="numeric"
                            value={prices[k] ? Number(prices[k]).toLocaleString("es-CO") : ""}
                            onChange={(e) => setPrices((p) => ({ ...p, [k]: e.target.value.replace(/\D/g, "") }))}
                            placeholder="—"
                            aria-label={`De ${origin.name} a ${dest.name}`}
                            className="w-16 bg-transparent text-center font-semibold tabular-nums outline-none"
                          />
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!matrix && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-ink-3">
                    Cargando tarifas…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-[1fr_1.4fr]">
        <section className="card flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold">Tarifa por defecto</h2>
          <p className="text-xs text-ink-3">Se cobra cuando la dirección no cae en ninguna zona de la tabla.</p>
          <label className="flex h-12 items-center gap-1 rounded-xl bg-sunken px-4 focus-within:ring-2 focus-within:ring-clapi/30">
            <span className="text-ink-3">$</span>
            <input
              inputMode="numeric"
              value={defaultFare ? Number(defaultFare).toLocaleString("es-CO") : ""}
              onChange={(e) => setDefaultFare(e.target.value.replace(/\D/g, ""))}
              className="w-full bg-transparent text-lg font-bold tabular-nums outline-none"
            />
          </label>
          {defaultFare && <p className="text-xs text-ink-3">{formatCOP(Number(defaultFare))} por domicilio fuera de zona</p>}
        </section>

        <section className="card flex flex-col gap-3 p-5">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Info size={15} className="text-ink-3" /> Cómo se reconoce cada zona
          </h2>
          <div className="flex flex-col gap-2">
            {zones.map((z) => (
              <div key={z.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="w-32 shrink-0 font-semibold text-ink">{z.name}</span>
                {z.keywords.map((k) => (
                  <span key={k} className="rounded-md bg-sunken px-2 py-0.5 text-ink-2">
                    {k}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
