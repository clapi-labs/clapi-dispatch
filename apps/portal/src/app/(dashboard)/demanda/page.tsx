"use client";

import { FALL_FRACTION, demandThresholds, type DemandConfig } from "@dispatch/shared/domain/demand";
import { ArrowDown, ArrowUp, Check, Gauge } from "lucide-react";
import { useState } from "react";

import { LEVEL, STALE_MS, pendingLabel, useDemand, type DemandData } from "@/components/DemandBar";
import { durationLabel, timeOfDay } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const SIGNAL = {
  alta: "pide subir",
  media: "está entre los dos umbrales: no mueve nada",
  baja: "pide bajar",
} as const;

const dayOf = (at: string) => new Date(at).toLocaleDateString("es-CO", { day: "numeric", month: "short", timeZone: "America/Bogota" });
const num = (n: number) => n.toLocaleString("es-CO", { maximumFractionDigits: 1 });

/**
 * La demanda (docs/ALGORITMO.md, «Demanda»): si está alta o baja y por qué,
 * cuándo cambió y con qué números, y los umbrales, que se cambian aquí sin
 * desplegar. Alta = el algoritmo en pico; baja = en valle.
 */
export default function DemandaPage() {
  const { data, failed, refresh } = useDemand(true);
  const now = useNow(15_000);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <div>
        <h1 className="text-lg font-semibold">Demanda</h1>
        <p className="text-sm text-ink-3">
          El sistema la mide solo con lo que está pasando: pedidos esperando moto, los que van entrando y las motos libres. Alta pone
          el algoritmo en pico (rapidez, hasta 3 pedidos por moto); baja, en valle (repartir parejo, hasta 2). La hora no cuenta.
        </p>
      </div>

      {failed && <p className="rounded-xl bg-danger-soft px-4 py-2.5 text-sm text-danger">No se pudo leer la demanda. Se reintenta solo.</p>}
      {!data ? <p className="card px-5 py-12 text-center text-sm text-ink-3">Cargando…</p> : <Current data={data} now={now} />}
      {data && <Thresholds config={data.config} data={data} onSaved={refresh} />}
      {data && <Log changes={data.changes ?? []} />}
    </div>
  );
}

function Current({ data, now }: { data: DemandData; now: number }) {
  const level = LEVEL[data.level];
  const m = data.now.metrics;
  const stale = !data.measuredAt || now - Date.parse(data.measuredAt) > STALE_MS;
  const pending = pendingLabel(data.pending);
  const stats = [
    { label: "Esperando moto", value: m.waiting, hint: m.scheduled ? `+${m.scheduled} con la comida para más tarde` : null },
    { label: `Entraron en ${m.windowMin} min`, value: m.arrivals, hint: null },
    { label: "Motos libres", value: m.free, hint: `de ${m.counted}` },
    {
      label: "Motos conectadas",
      value: m.connected,
      hint: m.live === m.connected ? "todas con GPS" : m.live ? `${m.live} con GPS: cuentan esas` : "ninguna con GPS: cuentan todas",
    },
  ];
  return (
    <section className="card flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${level.tone}`}>
          <Gauge size={16} /> {level.label}
        </span>
        <span className="text-sm text-ink-2">
          Algoritmo en <b>{level.mode}</b>
          {data.since && ` desde las ${timeOfDay(data.since)} (hace ${durationLabel((now - Date.parse(data.since)) / 1000)})`}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl bg-sunken px-3.5 py-3">
            <dt className="text-xs text-ink-3">{s.label}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{s.value}</dd>
            {s.hint && <dd className="text-xs text-ink-3">{s.hint}</dd>}
          </div>
        ))}
      </dl>
      <p className="text-sm text-ink-2">
        Ahora mismo la medición {SIGNAL[data.now.signal]}.{pending && <b> {pending}.</b>}
        {stale && <span className="text-danger"> No se está midiendo: el worker no ha corrido en el último minuto.</span>}
      </p>
    </section>
  );
}

type Field = { key: keyof DemandConfig; label: string; unit: string; step: string };

const FIELDS: { title: string; fields: Field[] }[] = [
  {
    title: "Pedidos esperando",
    fields: [
      { key: "waitingPerFree", label: "Por cada moto libre", unit: "pedidos", step: "0.5" },
      { key: "minWaiting", label: "Y como mínimo", unit: "pedidos", step: "1" },
      { key: "horizonMin", label: "Cuenta si la comida está lista en", unit: "min", step: "1" },
    ],
  },
  {
    title: "Pedidos que entran",
    fields: [
      { key: "arrivalsPerCourier", label: "Por cada moto", unit: "pedidos", step: "0.5" },
      { key: "minArrivals", label: "Y como mínimo", unit: "pedidos", step: "1" },
      { key: "windowMin", label: "En los últimos", unit: "min", step: "1" },
    ],
  },
  {
    title: "Cuánto tiene que durar",
    fields: [
      { key: "riseMin", label: "Para subir", unit: "min seguidos", step: "1" },
      { key: "fallMin", label: "Para bajar", unit: "min seguidos", step: "1" },
    ],
  },
];

const input = "ease-ui h-10 w-20 rounded-xl bg-sunken px-3 text-sm tabular-nums outline-none focus:ring-2 focus:ring-clapi/40";

function Thresholds({ config, data, onSaved }: { config: DemandConfig; data: DemandData; onSaved: () => void }) {
  const [form, setForm] = useState<Record<keyof DemandConfig, string>>(() => toForm(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = (Object.keys(config) as (keyof DemandConfig)[]).some((k) => Number(form[k].replace(",", ".")) !== config[k]);
  const up = demandThresholds(data.now.metrics, config);

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/demanda", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      setError(body?.error ?? "No se pudo guardar. Intenta de nuevo.");
      return;
    }
    setForm(toForm(await res.json()));
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    onSaved();
  }

  return (
    <section className="card flex flex-col gap-4 p-4 sm:p-5">
      <div>
        <p className="text-sm font-semibold">Umbrales</p>
        <p className="text-xs text-ink-3">
          Sube cuando los pedidos esperando llegan a su umbral, o cuando los que entran llegan al suyo con la mitad o menos de las
          motos libres, y se mantiene así los minutos para subir. Baja cuando los esperando quedan por debajo de la mitad ({num(FALL_FRACTION * 100)} %)
          y el ritmo también, o hay más de la mitad de las motos libres, y se mantiene así los minutos para bajar. Entre medio no
          cambia. El siguiente cálculo, en unos segundos, ya usa lo que se guarde.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {FIELDS.map((group) => (
          <fieldset key={group.title} className="flex flex-col gap-2 rounded-xl border border-line p-3.5">
            <legend className="px-1 text-xs font-semibold text-ink-2">{group.title}</legend>
            {group.fields.map((f) => (
              <label key={f.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-ink-2">{f.label}</span>
                <span className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={f.step}
                    value={form[f.key]}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    className={input}
                  />
                  <span className="w-20 text-xs text-ink-3">{f.unit}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <p className="text-xs text-ink-3">
        Con las motos de ahora sube con {num(up.waiting)} pedidos esperando o {num(up.arrivals)} que entren en {config.windowMin} min, y baja con
        menos de {num(up.waiting * FALL_FRACTION)} esperando y menos de {num(up.arrivals * FALL_FRACTION)} entrando.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="ease-ui flex h-11 items-center justify-center gap-2 rounded-xl bg-clapi px-5 text-sm font-semibold text-white shadow-sm disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Guardar umbrales"}
        </button>
        {error && <p className="text-sm text-danger">{error}</p>}
        {saved && (
          <p className="flex items-center gap-1.5 text-sm text-ok">
            <Check size={16} /> Guardado
          </p>
        )}
      </div>
    </section>
  );
}

function toForm(config: DemandConfig) {
  return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)])) as Record<keyof DemandConfig, string>;
}

function Log({ changes }: { changes: NonNullable<DemandData["changes"]> }) {
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-5 py-4 text-sm font-semibold">Registro de cambios (últimos 50)</div>
      {changes.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-3">Todavía no ha cambiado.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-ink-3">
              <tr className="border-b border-line">
                <th className="px-5 py-2 font-medium">Hora</th>
                <th className="px-3 py-2 font-medium">Cambio</th>
                <th className="px-3 py-2 font-medium">Con estos números</th>
                <th className="px-5 py-2 font-medium">Duró en el anterior</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {changes.map((c, i) => {
                const before = changes[i + 1];
                const Icon = c.level === "alta" ? ArrowUp : ArrowDown;
                return (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap px-5 py-2 tabular-nums text-ink-2">
                      {dayOf(c.at)} · {timeOfDay(c.at)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${LEVEL[c.level].tone}`}>
                        <Icon size={12} /> {c.level === "alta" ? "Subió a alta" : "Bajó a baja"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink-2">{c.summary}</td>
                    <td className="whitespace-nowrap px-5 py-2 tabular-nums text-ink-3">
                      {before ? durationLabel((Date.parse(c.at) - Date.parse(before.at)) / 1000) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
