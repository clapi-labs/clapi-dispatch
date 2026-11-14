"use client";

import { fareBreakdown, MAX_ZONE_ADJUSTMENT } from "@dispatch/shared/domain/fare";
import { Check, MapPinned, Plus, Route, Table2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatCOP } from "@/lib/format";
import type { FareRange } from "@/lib/types";

/** Una fila del formulario de rangos, como texto mientras se escribe. En la
 *  última `upToKm` no se usa y `perKm` es lo que se suma por km adicional. */
type RangeRow = { upToKm: string; price: string; perKm: string };

/** Lo que se ve antes de que se guarde la primera tabla: los cortes de 2 en 2 km, sin precios. */
const STARTER_ROWS: RangeRow[] = [
  { upToKm: "2", price: "", perKm: "" },
  { upToKm: "4", price: "", perKm: "" },
  { upToKm: "6", price: "", perKm: "" },
  { upToKm: "", price: "", perKm: "" },
];

type Examples = {
  porCalle: boolean;
  source: "calle" | "linea_recta";
  fallbacks: number;
  zones: { id: number; name: string; fareAdjustment: number; restaurants: number }[];
  restaurantsOutside: number;
  rows: { originZoneId: number; destinationZoneId: number; restaurants: number; km: number; kmMin: number; kmMax: number }[];
};

function toRows(ranges: FareRange[]): RangeRow[] {
  if (ranges.length === 0) return STARTER_ROWS;
  return ranges.map((r) => ({
    upToKm: r.upToKm === null ? "" : String(r.upToKm),
    price: String(r.price),
    perKm: r.upToKm === null && r.perKm ? String(r.perKm) : "",
  }));
}

/** "2,5" o "2.5" → 2.5. Vacío o inválido → NaN. */
function parseKm(text: string) {
  return text.trim() === "" ? NaN : Number(text.replace(",", "."));
}

function formatKm(km: number) {
  return km.toLocaleString("es-CO", { maximumFractionDigits: 1 });
}

/** «+2.000», «−1.000» o «0». */
function signedCOP(n: number) {
  return n === 0 ? "0" : `${n < 0 ? "−" : "+"}${formatCOP(Math.abs(n))}`;
}

/** Los rangos listos para guardar, o el primer problema que lo impide. */
function readRows(rows: RangeRow[]): { ranges: FareRange[] } | { error: string; row: number } {
  const ranges: FareRange[] = [];
  let previous = 0;
  for (let i = 0; i < rows.length; i++) {
    const last = i === rows.length - 1;
    const price = parseInt(rows[i].price, 10);
    if (!Number.isInteger(price)) return { error: "Falta el precio de algún rango.", row: i };
    if (!last) {
      const km = Math.round(parseKm(rows[i].upToKm) * 10) / 10;
      if (!Number.isFinite(km) || km <= previous) {
        return { error: `Cada rango tiene que terminar después de ${formatKm(previous)} km.`, row: i };
      }
      previous = km;
      ranges.push({ upToKm: km, price });
    } else {
      const perKm = rows[i].perKm.trim() === "" ? 0 : parseInt(rows[i].perKm, 10);
      ranges.push({ upToKm: null, price, perKm });
    }
  }
  return { ranges };
}

/** El ajuste escrito («-1.000», «2000», vacío = 0), o `null` si no sirve. */
function parseAdjustment(text: string): number | null {
  const clean = text.replace(/[.\s$]/g, "").replace("−", "-");
  if (clean === "" || clean === "-" || clean === "+") return 0;
  if (!/^[-+]?\d+$/.test(clean)) return null;
  const n = Number(clean);
  return Math.abs(n) <= MAX_ZONE_ADJUSTMENT ? n || 0 : null;
}

/** Mientras se escribe: el signo y los dígitos, con puntos de miles. */
function formatAdjustmentInput(text: string) {
  const negative = /^\s*[-−]/.test(text);
  const digits = text.replace(/\D/g, "");
  return (negative ? "-" : "") + (digits ? Number(digits).toLocaleString("es-CO") : "");
}

/**
 * Tarifas: el precio del domicilio es la tabla por km más el ajuste fijo de la
 * zona donde queda la entrega (`domain/fare.ts`, el mismo cálculo del bot).
 * Nada se guarda hasta "Guardar", así un dedo que se resbala en el celular no
 * cambia un precio de verdad; la tabla de ejemplos muestra el efecto antes.
 */
export default function TarifasPage() {
  const [savedRanges, setSavedRanges] = useState<FareRange[] | null>(null);
  const [rows, setRows] = useState<RangeRow[]>(STARTER_ROWS);
  const [examples, setExamples] = useState<Examples | null>(null);
  const [examplesFailed, setExamplesFailed] = useState(false);
  /** El ajuste de cada zona tal como se escribe, por id. */
  const [adjustments, setAdjustments] = useState<Record<number, string>>({});
  const [origin, setOrigin] = useState<number | "todas">("todas");
  /** Con el interruptor apagado: ver los ejemplos medidos por calle, como
   *  quedarán al encender la tabla nueva. */
  const [previewStreet, setPreviewStreet] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/fares/ranges", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: FareRange[]) => {
        setSavedRanges(data);
        setRows(toRows(data));
      });
    loadExamples(false, true);
  }, []);

  /** Los km de los ejemplos; `first`: también los ajustes guardados y la zona de origen. */
  function loadExamples(street: boolean, first = false) {
    setMeasuring(true);
    fetch(`/api/fares/ejemplos${street ? "?medida=calle" : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: Examples) => {
        setExamplesFailed(false);
        setPreviewStreet(street);
        if (!first) {
          // Los ajustes escritos se quedan; solo cambian los km.
          setExamples((prev) => (prev ? { ...data, zones: prev.zones } : data));
          return;
        }
        setExamples(data);
        setAdjustments(Object.fromEntries(data.zones.map((z) => [z.id, z.fareAdjustment ? formatAdjustmentInput(String(z.fareAdjustment)) : ""])));
        const firstOrigin = data.zones.find((z) => z.restaurants > 0);
        if (firstOrigin && data.zones.filter((z) => z.restaurants > 0).length > 1) setOrigin(firstOrigin.id);
      })
      .catch(() => setExamplesFailed(true))
      .finally(() => setMeasuring(false));
  }

  const rangesDirty = savedRanges !== null && JSON.stringify(toRows(savedRanges)) !== JSON.stringify(rows);
  const read = readRows(rows);
  const rangeError = rangesDirty && "error" in read ? read : null;

  /** El ajuste que se está viendo de cada zona (el escrito, o el guardado si no sirve). */
  const draftAdjustment = (id: number) => parseAdjustment(adjustments[id] ?? "") ?? examples?.zones.find((z) => z.id === id)?.fareAdjustment ?? 0;
  const badAdjustments = (examples?.zones ?? []).filter((z) => parseAdjustment(adjustments[z.id] ?? "") === null).map((z) => z.id);
  const changedAdjustments = (examples?.zones ?? [])
    .filter((z) => parseAdjustment(adjustments[z.id] ?? "") !== null && parseAdjustment(adjustments[z.id] ?? "") !== z.fareAdjustment)
    .map((z) => ({ id: z.id, fareAdjustment: parseAdjustment(adjustments[z.id] ?? "")! }));
  const dirty = rangesDirty || changedAdjustments.length > 0;

  // La tabla de ejemplos usa lo que se está escribiendo; si los rangos tienen
  // un error, la última tabla guardada.
  const previewRanges = "ranges" in read ? read.ranges : (savedRanges ?? []);
  const zoneName = useMemo(() => new Map((examples?.zones ?? []).map((z) => [z.id, z.name])), [examples]);
  const origins = (examples?.zones ?? []).filter((z) => z.restaurants > 0);
  const exampleRows = (examples?.rows ?? [])
    .filter((r) => origin === "todas" || r.originZoneId === origin)
    .map((r) => {
      const destination = examples!.zones.find((z) => z.id === r.destinationZoneId)!;
      const b = fareBreakdown(r.km, previewRanges, { id: destination.id, name: destination.name, fareAdjustment: draftAdjustment(destination.id) });
      return { ...r, breakdown: b };
    })
    .sort(
      (a, b) =>
        (zoneName.get(a.originZoneId) ?? "").localeCompare(zoneName.get(b.originZoneId) ?? "", "es") ||
        a.km - b.km ||
        (zoneName.get(a.destinationZoneId) ?? "").localeCompare(zoneName.get(b.destinationZoneId) ?? "", "es"),
    );

  async function save() {
    if (rangeError || badAdjustments.length || !("ranges" in read)) return;
    setSaving(true);
    setFailed(null);
    try {
      if (rangesDirty) {
        const result = await fetch("/api/fares/ranges", { method: "PUT", body: JSON.stringify({ ranges: read.ranges }) });
        if (!result.ok) throw new Error("No se pudo guardar la tabla por km. Intenta de nuevo.");
        setSavedRanges(read.ranges);
      }
      if (changedAdjustments.length) {
        const result = await fetch("/api/fares/ajustes", { method: "PUT", body: JSON.stringify({ adjustments: changedAdjustments }) });
        if (!result.ok) throw new Error("No se pudieron guardar los ajustes por zona. Intenta de nuevo.");
        const byId = new Map(changedAdjustments.map((c) => [c.id, c.fareAdjustment]));
        setExamples((prev) => prev && { ...prev, zones: prev.zones.map((z) => (byId.has(z.id) ? { ...z, fareAdjustment: byId.get(z.id)! } : z)) });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "No se pudo guardar. Intenta de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  function setRow(i: number, patch: Partial<RangeRow>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  /** Un rango nuevo justo antes del último ("desde X km"), 2 km después del penúltimo tope. */
  function addRow() {
    setRows((prev) => {
      const lastTop = prev.length > 1 ? parseKm(prev[prev.length - 2].upToKm) : 0;
      const next = Number.isFinite(lastTop) ? String(lastTop + 2) : "";
      return [...prev.slice(0, -1), { upToKm: next, price: "", perKm: "" }, prev[prev.length - 1]];
    });
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, j) => j !== i));
  }

  const priceInput = (value: string, onChange: (v: string) => void, label: string, width = "w-32") => (
    <label className={`ease-ui flex h-10 ${width} shrink-0 items-center gap-1 rounded-lg bg-sunken px-3 focus-within:ring-2 focus-within:ring-clapi/30`}>
      <span className="text-xs text-ink-3">$</span>
      <input
        inputMode="numeric"
        value={value ? Number(value).toLocaleString("es-CO") : ""}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        placeholder="—"
        aria-label={label}
        className="w-full bg-transparent text-right font-semibold tabular-nums outline-none"
      />
    </label>
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {failed && <p className="text-sm text-danger">{failed}</p>}
        {dirty && !failed && <p className="text-xs text-ink-3">Sin guardar: el bot sigue cobrando con lo guardado.</p>}
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving || rangeError !== null || badAdjustments.length > 0}
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
                  <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:gap-3 sm:px-5">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                      {last ? (
                        <span className="font-semibold">{i === 0 ? "Cualquier distancia" : `Más de ${fromText} km`}</span>
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

                    {priceInput(row.price, (price) => setRow(i, { price }), last ? "Precio base desde el último tope" : `Precio del rango ${i + 1}`)}

                    {/* El último siempre queda: es el que cubre cualquier distancia. */}
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      disabled={last}
                      aria-label="Quitar este rango"
                      className="ease-ui flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-3 disabled:invisible can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>

                    {last && (
                      <div className="flex w-full items-center justify-end gap-2 pr-12 text-sm text-ink-2">
                        <span>más</span>
                        {priceInput(row.perKm, (perKm) => setRow(i, { perKm }), "Precio por cada km adicional", "w-28")}
                        <span>por cada km adicional</span>
                      </div>
                    )}
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
            {rangeError ? (
              <p className="text-xs text-danger">{rangeError.error}</p>
            ) : (
              <p className="text-xs text-ink-3">El km adicional se cobra por fracción: 4,1 km ya paga uno.</p>
            )}
          </div>
        </section>

        {/* Ajuste fijo por zona de entrega. */}
        <section className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
            <MapPinned size={16} className="text-clapi" /> Ajuste por zona
            <span className="ml-auto text-xs font-normal text-ink-3">Donde queda la entrega</span>
          </div>
          {examples === null ? (
            <p className="px-5 py-12 text-center text-sm text-ink-3">{examplesFailed ? "No se pudieron leer las zonas. Recarga la página." : "Cargando zonas…"}</p>
          ) : examples.zones.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-3">Todavía no hay zonas de servicio. Se marcan en Zonas.</p>
          ) : (
            <ul className="flex max-h-112 flex-col divide-y divide-line overflow-y-auto">
              {[...examples.zones]
                .sort((a, b) => a.name.localeCompare(b.name, "es"))
                .map((z) => {
                  const bad = badAdjustments.includes(z.id);
                  return (
                    <li key={z.id} className="flex items-center gap-3 px-4 py-2 sm:px-5">
                      <span className="min-w-0 flex-1 truncate text-sm">{z.name}</span>
                      <label
                        className={`ease-ui flex h-9 w-32 shrink-0 items-center gap-1 rounded-lg bg-sunken px-3 focus-within:ring-2 ${bad ? "ring-2 ring-danger/60" : "focus-within:ring-clapi/30"}`}
                      >
                        <span className="text-xs text-ink-3">$</span>
                        <input
                          inputMode="text"
                          value={adjustments[z.id] ?? ""}
                          onChange={(e) => setAdjustments((prev) => ({ ...prev, [z.id]: formatAdjustmentInput(e.target.value) }))}
                          placeholder="0"
                          aria-label={`Ajuste de ${z.name}, en pesos (negativo para bajar)`}
                          className="w-full bg-transparent text-right font-semibold tabular-nums outline-none"
                        />
                      </label>
                    </li>
                  );
                })}
            </ul>
          )}
          <p className="border-t border-line px-4 py-3 text-xs text-ink-3 sm:px-5">
            Se suma al precio de la tabla; con un menos adelante («-1.000») se resta. El total nunca baja de 0. Aplica desde la siguiente cotización: los pedidos
            que ya tienen precio no cambian.
          </p>
        </section>
      </div>

      {/* Ejemplos: lo que cobraría el bot, zona por zona, con lo que se está escribiendo. */}
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
          <Table2 size={16} className="text-clapi" /> Ejemplos zona por zona
          {examples && !examples.porCalle && (
            <label className="ml-auto flex items-center gap-2 text-xs font-normal text-ink-2">
              <input type="checkbox" checked={previewStreet} disabled={measuring} onChange={(e) => loadExamples(e.target.checked)} className="h-4 w-4 accent-clapi" />
              {measuring ? "Midiendo…" : "Medir por calle (como quedará al encender)"}
            </label>
          )}
          {origins.length > 1 && (
            <label className={`${examples && !examples.porCalle ? "" : "ml-auto "}flex items-center gap-2 text-xs font-normal text-ink-3`}>
              Desde
              <select
                value={origin}
                onChange={(e) => setOrigin(e.target.value === "todas" ? "todas" : Number(e.target.value))}
                className="h-9 rounded-lg bg-sunken px-2 text-sm font-semibold text-ink outline-none focus:ring-2 focus:ring-clapi/30"
              >
                <option value="todas">Todas las zonas</option>
                {origins.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} ({z.restaurants} {z.restaurants === 1 ? "restaurante" : "restaurantes"})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p className="border-b border-line px-5 py-2.5 text-xs text-ink-3">
          Km de los restaurantes de cada zona al centro de la zona de destino ({examples?.source === "calle" ? (examples.porCalle ? "por calle, como cobra el bot" : "por calle: vista previa, el bot todavía cobra en línea recta × 1,3") : "en línea recta × 1,3, como cobra hoy el bot"}): el
          típico es la mediana, y entre paréntesis el rango. Los precios salen de lo que está escrito arriba, aunque no esté guardado.
          {examples && examples.fallbacks > 0 && ` ${examples.fallbacks} medidas salieron en línea recta porque el mapa de calles no respondió.`}
          {examples && examples.restaurantsOutside > 0 && ` ${examples.restaurantsOutside} restaurantes quedan fuera de las zonas y no entran.`}
          {rangeError && " La tabla por km tiene un error: los ejemplos usan la guardada."}
        </p>
        {examples === null ? (
          <p className="px-5 py-12 text-center text-sm text-ink-3">{examplesFailed ? "No se pudieron calcular los ejemplos." : "Midiendo distancias…"}</p>
        ) : exampleRows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-3">
            {examples.zones.length === 0 ? "Sin zonas de servicio no hay ejemplos." : "Ningún restaurante con ubicación queda dentro de una zona."}
          </p>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-ink-3">
                <tr className="border-b border-line">
                  {origin === "todas" && <th className="px-5 py-2 font-medium">Desde</th>}
                  <th className="px-5 py-2 font-medium">Hasta</th>
                  <th className="px-3 py-2 text-right font-medium">Km típicos</th>
                  <th className="px-3 py-2 text-right font-medium">Tabla</th>
                  <th className="px-3 py-2 text-right font-medium">Ajuste</th>
                  <th className="px-5 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {exampleRows.map((r) => (
                  <tr key={`${r.originZoneId}:${r.destinationZoneId}`}>
                    {origin === "todas" && <td className="px-5 py-2 text-ink-2">{zoneName.get(r.originZoneId)}</td>}
                    <td className="px-5 py-2">{zoneName.get(r.destinationZoneId)}</td>
                    <td className="px-3 py-2 text-right">
                      {formatKm(r.km)}
                      {r.kmMin !== r.kmMax && (
                        <span className="text-xs text-ink-3">
                          {" "}
                          ({formatKm(r.kmMin)}–{formatKm(r.kmMax)})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{r.breakdown ? formatCOP(r.breakdown.table) : "—"}</td>
                    <td className={`px-3 py-2 text-right ${r.breakdown?.adjustment ? "" : "text-ink-3"}`}>{r.breakdown ? signedCOP(r.breakdown.adjustment) : "—"}</td>
                    <td className="px-5 py-2 text-right font-semibold">{r.breakdown ? formatCOP(r.breakdown.total) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
