"use client";

import { Check, ChevronDown, Info, MapPinned, Plus, Route, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatCOP } from "@/lib/format";
import type { FareMatrix, FareRange } from "@/lib/types";

const key = (o: number, d: number) => `${o}-${d}`;

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
 * Tarifas: el precio del domicilio por rangos de kilómetros, más la tarifa
 * por defecto. Nada se guarda hasta "Guardar", así un dedo que se resbala en
 * el celular no cambia un precio de verdad.
 *
 * La matriz por zonas sigue abajo, plegada: es la que usa el bot hasta que
 * pueda medir la distancia entre direcciones (ver FareRange en shared).
 */
export default function TarifasPage() {
  const [matrix, setMatrix] = useState<FareMatrix | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [defaultFare, setDefaultFare] = useState("");
  const [savedRanges, setSavedRanges] = useState<FareRange[] | null>(null);
  const [rows, setRows] = useState<RangeRow[]>(STARTER_ROWS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/fares", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: FareMatrix) => {
        setMatrix(data);
        setPrices(Object.fromEntries(data.fares.map((f) => [key(f.originZoneId, f.destinationZoneId), String(f.price)])));
        setDefaultFare(String(data.defaultFare));
      });
    fetch("/api/fares/ranges", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: FareRange[]) => {
        setSavedRanges(data);
        setRows(toRows(data));
      });
  }, []);

  const matrixDirty = useMemo(() => {
    if (!matrix) return false;
    const original = Object.fromEntries(matrix.fares.map((f) => [key(f.originZoneId, f.destinationZoneId), String(f.price)]));
    return Object.entries(prices).some(([k, v]) => original[k] !== v) || String(matrix.defaultFare) !== defaultFare;
  }, [matrix, prices, defaultFare]);

  const rangesDirty = savedRanges !== null && JSON.stringify(toRows(savedRanges)) !== JSON.stringify(rows);
  const read = readRows(rows);
  const rangeError = rangesDirty && "error" in read ? read : null;
  const dirty = matrixDirty || rangesDirty;

  async function save() {
    if (!matrix || rangeError) return;
    setSaving(true);
    setFailed(false);
    const requests: Promise<Response>[] = [];

    if (rangesDirty && "ranges" in read) {
      requests.push(fetch("/api/fares/ranges", { method: "PUT", body: JSON.stringify({ ranges: read.ranges }) }));
    }

    const fares = matrix.zones.flatMap((o) =>
      matrix.zones
        .map((d) => ({ originZoneId: o.id, destinationZoneId: d.id, price: parseInt(prices[key(o.id, d.id)] ?? "", 10) }))
        .filter((f) => Number.isInteger(f.price)),
    );
    const fallback = parseInt(defaultFare, 10) || 0;
    if (matrixDirty) {
      requests.push(fetch("/api/fares", { method: "PUT", body: JSON.stringify({ fares, defaultFare: fallback }) }));
    }

    const results = await Promise.all(requests);
    setSaving(false);
    if (results.some((r) => !r.ok)) {
      setFailed(true);
      return;
    }
    if (matrixDirty) setMatrix({ ...matrix, fares, defaultFare: fallback });
    if (rangesDirty && "ranges" in read) setSavedRanges(read.ranges);
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

  const zones = matrix?.zones ?? [];

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

        <section className="card flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold">Tarifa por defecto</h2>
          <p className="text-xs text-ink-3">Se cobra cuando no se logra ubicar la dirección.</p>
          <label className="flex h-12 items-center gap-1 rounded-xl bg-sunken px-4 focus-within:ring-2 focus-within:ring-clapi/30">
            <span className="text-ink-3">$</span>
            <input
              inputMode="numeric"
              value={defaultFare ? Number(defaultFare).toLocaleString("es-CO") : ""}
              onChange={(e) => setDefaultFare(e.target.value.replace(/\D/g, ""))}
              className="w-full bg-transparent text-lg font-bold tabular-nums outline-none"
            />
          </label>
          {defaultFare && <p className="text-xs text-ink-3">{formatCOP(Number(defaultFare))} por domicilio</p>}
        </section>
      </div>

      <div className="flex gap-3 rounded-2xl bg-gold-soft p-4 text-sm text-gold-ink">
        <Info size={18} className="mt-0.5 shrink-0" />
        <p>
          <strong>El bot todavía cobra por zona.</strong> Para cobrar por kilómetros tiene que medir la distancia entre la recogida y la
          entrega, y eso aún no está conectado. Mientras tanto usa la tabla por zonas de abajo.
        </p>
      </div>

      {/* La matriz por zonas: la que usa el bot hoy. Plegada para que no compita con la de distancia. */}
      <details className="card group overflow-hidden">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <MapPinned size={16} className="text-clapi" /> Tarifas por zona
          <span className="text-xs font-normal text-ink-3">· las que usa el bot hoy</span>
          <ChevronDown size={16} className="ease-ui ml-auto text-ink-3 group-open:rotate-180" />
        </summary>

        <div className="overflow-x-auto border-t border-line">
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

        <div className="flex flex-col gap-2 border-t border-line px-5 py-4">
          <p className="text-xs font-semibold text-ink-2">Cómo se reconoce cada zona</p>
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
      </details>
    </div>
  );
}
