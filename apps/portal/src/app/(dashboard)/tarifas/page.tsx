"use client";

import { Check, Info, Plus, Route, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { FareRange } from "@/lib/types";

/** Una fila del formulario de rangos, como texto mientras se escribe. En la última `upToKm` no se usa. */
type RangeRow = { upToKm: string; price: string };

/** Lo que se ve antes de que se guarde la primera tabla: los cortes de 2 en 2 km, sin precios. */
const STARTER_ROWS: RangeRow[] = [
  { upToKm: "2", price: "" },
  { upToKm: "4", price: "" },
  { upToKm: "6", price: "" },
  { upToKm: "", price: "" },
];

function toRows(ranges: FareRange[]): RangeRow[] {
  if (ranges.length === 0) return STARTER_ROWS;
  return ranges.map((r) => ({ upToKm: r.upToKm === null ? "" : String(r.upToKm), price: String(r.price) }));
}

/** "2,5" o "2.5" → 2.5. Vacío o inválido → NaN. */
function parseKm(text: string) {
  return text.trim() === "" ? NaN : Number(text.replace(",", "."));
}

function formatKm(km: number) {
  return km.toLocaleString("es-CO", { maximumFractionDigits: 1 });
}

/** Los rangos listos para guardar, o el primer problema que lo impide. */
function readRows(rows: RangeRow[]): { ranges: FareRange[] } | { error: string; row: number } {
  const ranges: FareRange[] = [];
  let previous = 0;
  for (let i = 0; i < rows.length; i++) {
    const last = i === rows.length - 1;
    const price = parseInt(rows[i].price, 10);
    if (!last) {
      const km = Math.round(parseKm(rows[i].upToKm) * 10) / 10;
      if (!Number.isFinite(km) || km <= previous) {
        return { error: `Cada rango tiene que terminar después de ${formatKm(previous)} km.`, row: i };
      }
      previous = km;
      if (!Number.isInteger(price)) return { error: "Falta el precio de algún rango.", row: i };
      ranges.push({ upToKm: km, price });
    } else {
      if (!Number.isInteger(price)) return { error: "Falta el precio de algún rango.", row: i };
      ranges.push({ upToKm: null, price });
    }
  }
  return { ranges };
}

/**
 * Tarifas: el precio del domicilio por rangos de kilómetros, la única forma
 * de cobrar. Nada se guarda hasta "Guardar", así un dedo que se resbala en el
 * celular no cambia un precio de verdad.
 */
export default function TarifasPage() {
  const [savedRanges, setSavedRanges] = useState<FareRange[] | null>(null);
  const [rows, setRows] = useState<RangeRow[]>(STARTER_ROWS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/fares/ranges", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: FareRange[]) => {
        setSavedRanges(data);
        setRows(toRows(data));
      });
  }, []);

  const rangesDirty = savedRanges !== null && JSON.stringify(toRows(savedRanges)) !== JSON.stringify(rows);
  const read = readRows(rows);
  const rangeError = rangesDirty && "error" in read ? read : null;
  const dirty = rangesDirty;

  async function save() {
    if (rangeError || !("ranges" in read)) return;
    setSaving(true);
    setFailed(false);
    const result = await fetch("/api/fares/ranges", { method: "PUT", body: JSON.stringify({ ranges: read.ranges }) });
    setSaving(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setSavedRanges(read.ranges);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function setRow(i: number, patch: Partial<RangeRow>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  /** Un rango nuevo justo antes del último ("más de"), 2 km después del penúltimo tope. */
  function addRow() {
    setRows((prev) => {
      const lastTop = prev.length > 1 ? parseKm(prev[prev.length - 2].upToKm) : 0;
      const next = Number.isFinite(lastTop) ? String(lastTop + 2) : "";
      return [...prev.slice(0, -1), { upToKm: next, price: "" }, prev[prev.length - 1]];
    });
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, j) => j !== i));
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {failed && <p className="text-sm text-danger">No se pudo guardar. Intenta de nuevo.</p>}
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving || rangeError !== null}
          className="ease-ui flex h-11 items-center gap-2 rounded-xl bg-clapi px-5 text-sm font-semibold text-white shadow-sm disabled:opacity-40"
        >
          {saved ? <Check size={17} /> : null}
          {saving ? "Guardando…" : saved ? "Guardado" : "Guardar cambios"}
        </button>
      </div>

      <div className="grid items-start gap-3 md:grid-cols-[1.4fr_1fr]">
        {/* Tarifa por distancia: la tabla de rangos. */}
        <section className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
            <Route size={16} className="text-clapi" /> Precio por distancia
            <span className="ml-auto text-xs font-normal text-ink-3">De la recogida a la entrega</span>
          </div>

          {savedRanges === null ? (
            <p className="px-5 py-12 text-center text-sm text-ink-3">Cargando tarifas…</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {rows.map((row, i) => {
                const last = i === rows.length - 1;
                const from = i === 0 ? 0 : parseKm(rows[i - 1].upToKm);
                const fromText = Number.isFinite(from) ? formatKm(from) : "…";
                const bad = rangeError?.row === i;
                return (
                  <li key={i} className="flex items-center gap-2 px-4 py-2.5 sm:gap-3 sm:px-5">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                      {last ? (
                        <span className="font-semibold">Más de {fromText} km</span>
                      ) : (
                        <>
                          <span className="shrink-0 text-ink-2">{i === 0 ? "Hasta" : `De ${fromText} a`}</span>
                          <label
                            className={`ease-ui flex h-10 items-center gap-1 rounded-lg bg-sunken px-2.5 focus-within:ring-2 ${
                              bad ? "ring-2 ring-danger/60" : "focus-within:ring-clapi/30"
                            }`}
                          >
                            <input
                              inputMode="decimal"
                              value={row.upToKm}
                              onChange={(e) => setRow(i, { upToKm: e.target.value.replace(/[^\d.,]/g, "") })}
                              aria-label={`Fin del rango ${i + 1}, en kilómetros`}
                              className="w-10 bg-transparent text-right font-semibold tabular-nums outline-none"
                            />
                            <span className="text-xs text-ink-3">km</span>
                          </label>
                        </>
                      )}
                    </div>

                    <label className="ease-ui flex h-10 w-32 shrink-0 items-center gap-1 rounded-lg bg-sunken px-3 focus-within:ring-2 focus-within:ring-clapi/30">
                      <span className="text-xs text-ink-3">$</span>
                      <input
                        inputMode="numeric"
                        value={row.price ? Number(row.price).toLocaleString("es-CO") : ""}
                        onChange={(e) => setRow(i, { price: e.target.value.replace(/\D/g, "") })}
                        placeholder="—"
                        aria-label={`Precio del rango ${i + 1}`}
                        className="w-full bg-transparent text-right font-semibold tabular-nums outline-none"
                      />
                    </label>

                    {/* El último ("más de") siempre queda: es el que cubre cualquier distancia. */}
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      disabled={last}
                      aria-label="Quitar este rango"
                      className="ease-ui flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-3 disabled:invisible can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 sm:px-5">
            <button
              type="button"
              onClick={addRow}
              disabled={savedRanges === null}
              className="ease-ui flex h-9 items-center gap-1.5 rounded-lg bg-clapi-soft px-3 text-xs font-semibold text-clapi-ink disabled:opacity-40 can-hover:hover:brightness-95"
            >
              <Plus size={14} /> Agregar rango
            </button>
            {rangeError && <p className="text-xs text-danger">{rangeError.error}</p>}
          </div>
        </section>

        <div className="flex gap-3 rounded-2xl bg-gold-soft p-4 text-sm text-gold-ink">
          <Info size={18} className="mt-0.5 shrink-0" />
          <p>
            El bot ubica la recogida y la entrega en el mapa y cobra según la distancia por calles. Si no logra ubicar una
            dirección, no inventa un precio: pide corregirla o pasa el pedido a la central.
          </p>
        </div>
      </div>

    </div>
  );
}
