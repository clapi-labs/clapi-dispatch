"use client";

import { Building2, ChevronLeft, ChevronRight, Download, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";

import { useTrips } from "@/components/TripsProvider";
import { BRAND } from "@/lib/brand";
import { formatCOP, initials } from "@/lib/format";
import { buildWeeklyReportPdf, downloadPdf, reportFileName } from "@/lib/pdf";
import type { Settlement } from "@/lib/types";
import { addDays, bogotaDate, DAY_NAMES, longDate, shortDate, weekRange, weekStart } from "@/lib/week";

const EMPTY: Settlement = { total: 0, deliveredCount: 0, averageFee: 0, agencyRate: 0.1, agencyShare: 0, couriers: [] };

/** «semana» = el acumulado lunes–domingo; si no, un día `YYYY-MM-DD` de esa semana. */
type Tab = string;

export default function ArqueoPage() {
  const { trips } = useTrips();
  const [loaded, setLoaded] = useState<{ key: string; data: Settlement }>({ key: "", data: EMPTY });
  const [failed, setFailed] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [today, setToday] = useState(() => bogotaDate(Date.now()));
  const [week, setWeek] = useState(() => weekStart(bogotaDate(Date.now())));
  const [tab, setTab] = useState<Tab>("semana");
  const deliveredCount = trips.filter((t) => t.status === "delivered").length;
  const range = weekRange(week);
  const isCurrentWeek = week === weekStart(today);
  // Mientras llega lo de la semana o el día recién elegido se atenúa lo anterior; una entrega nueva no parpadea.
  const key = `${week}|${tab}`;
  const data = loaded.data;
  const loading = loaded.key !== key;

  // «Hoy» puede cambiar con la pantalla abierta (pasa la medianoche de Colombia).
  useEffect(() => {
    const id = setInterval(() => setToday(bogotaDate(Date.now())), 60_000);
    return () => clearInterval(id);
  }, []);

  // Se recalcula cada vez que hay una entrega nueva o se cambia de semana o de día:
  // el cierre se mueve solo mientras la operación corre.
  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({ semana: week });
    if (tab !== "semana") query.set("dia", tab);
    fetch(`/api/settlement?${query}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: Settlement) => {
        if (!current) return;
        setLoaded({ key, data: body });
        setFailed(false);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [deliveredCount, week, tab, key]);

  function goToWeek(next: string) {
    setWeek(next);
    setTab("semana");
  }

  async function downloadReport() {
    setPdfBusy(true);
    try {
      // Siempre con los datos de toda la semana, aunque se esté viendo un solo día.
      const res = await fetch(`/api/settlement?${new URLSearchParams({ semana: week })}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      downloadPdf(buildWeeklyReportPdf((await res.json()) as Settlement, BRAND.client.name), reportFileName(week));
    } catch {
      setFailed(true);
    } finally {
      setPdfBusy(false);
    }
  }

  const rate = `${Math.round(data.agencyRate * 100)} %`;
  const isWeek = tab === "semana";
  const dayLabel = isWeek ? "" : tab === today ? "hoy" : `el ${longDate(tab).toLowerCase()}`;
  const days = data.days ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      {/* Semana de lunes a domingo (hora de Colombia) y descarga del reporte. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => goToWeek(addDays(week, -7))} aria-label="Semana anterior" className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white hover:bg-sunken">
            <ChevronLeft size={18} />
          </button>
          <div className="min-w-0 px-2 text-center">
            <p className="text-sm font-semibold">
              {shortDate(range.start)} – {shortDate(range.end)}
            </p>
            <p className="text-[11px] text-ink-3">{isCurrentWeek ? "Esta semana" : "Lunes a domingo"}</p>
          </div>
          <button type="button" onClick={() => goToWeek(addDays(week, 7))} disabled={isCurrentWeek} aria-label="Semana siguiente" className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white hover:bg-sunken disabled:opacity-40">
            <ChevronRight size={18} />
          </button>
          {!isCurrentWeek && (
            <button type="button" onClick={() => goToWeek(weekStart(today))} className="ml-2 rounded-lg px-2.5 py-2 text-xs font-semibold text-clapi hover:bg-sunken">
              Esta semana
            </button>
          )}
        </div>
        <button type="button" onClick={downloadReport} disabled={pdfBusy} className="flex items-center gap-2 rounded-lg bg-clapi px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-60">
          <Download size={16} /> {pdfBusy ? "Generando…" : "Descargar PDF"}
        </button>
      </div>

      {/* Pestañas: la semana completa o un día. */}
      <div role="tablist" aria-label="Día de la semana" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
        <button type="button" role="tab" aria-selected={isWeek} onClick={() => setTab("semana")} className={`shrink-0 rounded-xl border px-4 py-2 text-sm font-semibold ${isWeek ? "border-clapi bg-clapi text-white" : "border-line bg-white hover:bg-sunken"}`}>
          Semana
        </button>
        {range.days.map((d) => {
          const active = tab === d.date;
          const isToday = d.date === today;
          return (
            <button key={d.date} type="button" role="tab" aria-selected={active} onClick={() => setTab(d.date)} className={`shrink-0 rounded-xl border px-3.5 py-1.5 text-center ${active ? "border-clapi bg-clapi text-white" : isToday ? "border-clapi bg-white text-clapi" : "border-line bg-white hover:bg-sunken"}`}>
              <span className="block text-sm font-semibold">{DAY_NAMES[d.index]}</span>
              <span className={`block text-[11px] ${active ? "text-white/80" : "text-ink-3"}`}>{shortDate(d.date)}</span>
            </button>
          );
        })}
      </div>

      {failed && <p className="rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700">No se pudo cargar el cierre. Reintenta en un momento.</p>}

      {/* Solo los domicilios del periodo: lo que generaron las motos y la parte de la agencia. */}
      <div className={`grid gap-3 sm:grid-cols-[3fr_2fr] ${loading ? "opacity-60" : ""}`}>
        <section className="relative overflow-hidden rounded-2xl bg-clapi p-5 text-white shadow-sm lg:p-6">
          <span className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" />
          <span className="absolute -bottom-16 right-16 h-32 w-32 rounded-full bg-white/5" />
          <p className="flex items-center gap-2 text-sm font-medium text-white/80">
            <TrendingUp size={16} /> Total generado {isWeek ? "en la semana" : dayLabel}
          </p>
          <p className="mt-1 text-4xl font-extrabold tracking-tight tabular-nums lg:text-5xl">{formatCOP(data.total)}</p>
          <p className="mt-2 text-sm text-white/80">
            {data.deliveredCount} domicilios entregados · promedio {formatCOP(data.averageFee)}
          </p>
        </section>
        <section className="relative flex flex-col justify-center overflow-hidden rounded-2xl bg-gold p-5 text-clapi-deep shadow-sm lg:p-6">
          <span className="absolute -right-6 -top-12 h-52 w-8 rotate-45 bg-white/20" />
          <span className="absolute right-8 -top-12 h-52 w-5 rotate-45 bg-white/15" />
          <span className="absolute right-[4.5rem] -top-12 h-52 w-2.5 rotate-45 bg-white/10" />
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Building2 size={16} /> Para {BRAND.client.name} ({rate})
          </p>
          <p className="mt-1 text-3xl font-extrabold tracking-tight tabular-nums lg:text-4xl">{formatCOP(data.agencyShare)}</p>
        </section>
      </div>

      {/* Semana: el resumen compacto de lunes a domingo. */}
      {isWeek && (
        <section className={`card overflow-hidden ${loading ? "opacity-60" : ""}`}>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold">Por día</h2>
          </div>
          <div className="grid grid-cols-[1fr_3.5rem_6.5rem_6.5rem] gap-3 border-b border-line bg-sunken/60 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3 md:grid-cols-[1fr_7rem_9rem_11rem] md:gap-4">
            <span>Día</span>
            <span className="text-right">Viajes</span>
            <span className="text-right">Generado</span>
            <span className="text-right">Agencia</span>
          </div>
          {days.map((d, i) => (
            <button key={d.date} type="button" onClick={() => setTab(d.date)} className={`grid w-full grid-cols-[1fr_3.5rem_6.5rem_6.5rem] gap-3 border-b border-line px-5 py-3 text-left text-sm last:border-0 hover:bg-sunken/60 md:grid-cols-[1fr_7rem_9rem_11rem] md:gap-4 ${d.date === today ? "font-semibold" : ""}`}>
              <span>
                {DAY_NAMES[i]} <span className="text-ink-3">{shortDate(d.date)}</span>
                {d.date === today && <span className="ml-2 rounded bg-gold px-1.5 py-0.5 text-[10px] font-bold text-clapi-deep">HOY</span>}
              </span>
              <span className="text-right tabular-nums">{d.deliveredCount}</span>
              <span className="text-right tabular-nums">{formatCOP(d.total)}</span>
              <span className="text-right tabular-nums">{formatCOP(d.agencyShare)}</span>
            </button>
          ))}
        </section>
      )}

      {/* Desglose por moto */}
      <section className={`card overflow-hidden ${loading ? "opacity-60" : ""}`}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold">Por motorizado</h2>
        </div>

        <div className="hidden grid-cols-[1fr_7rem_9rem_11rem] gap-4 border-b border-line bg-sunken/60 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3 md:grid">
          <span>Motorizado</span>
          <span className="text-right">Viajes</span>
          <span className="text-right">Generado</span>
          <span className="text-right">Para la agencia</span>
        </div>

        {data.couriers.map((row) => (
          <div key={row.courierName} className="border-b border-line px-5 py-4 last:border-0 md:grid md:grid-cols-[1fr_7rem_9rem_11rem] md:items-center md:gap-4">
            <span className="flex items-center gap-3 font-semibold">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-clapi text-xs font-bold text-white">
                {initials(row.courierName)}
              </span>
              {row.courierName}
            </span>

            {/* Celular: tres datos en fila debajo del nombre. Escritorio: columnas. */}
            <div className="mt-3 grid grid-cols-3 gap-2 md:contents">
              <span className="rounded-lg bg-sunken px-2.5 py-1.5 md:bg-transparent md:p-0 md:text-right">
                <span className="block text-[10px] font-semibold uppercase text-ink-3 md:hidden">Viajes</span>
                <span className="font-semibold tabular-nums">{row.deliveredCount}</span>
              </span>
              <span className="rounded-lg bg-sunken px-2.5 py-1.5 md:bg-transparent md:p-0 md:text-right">
                <span className="block text-[10px] font-semibold uppercase text-ink-3 md:hidden">Generado</span>
                <span className="font-semibold tabular-nums">{formatCOP(row.earned)}</span>
              </span>
              <span className="rounded-lg bg-sunken px-2.5 py-1.5 md:bg-transparent md:p-0 md:text-right">
                <span className="block text-[10px] font-semibold uppercase text-ink-3 md:hidden">Agencia {rate}</span>
                <span className="font-semibold tabular-nums">{formatCOP(row.agencyShare)}</span>
              </span>
            </div>
          </div>
        ))}

        {data.couriers.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-ink-3">{isWeek ? "No hubo entregas cerradas esta semana." : `No hubo entregas cerradas ${dayLabel}.`}</p>
        )}
      </section>
    </div>
  );
}
