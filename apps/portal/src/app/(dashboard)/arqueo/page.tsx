"use client";

import { Building2, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";

import { useTrips } from "@/components/TripsProvider";
import { BRAND } from "@/lib/brand";
import { formatCOP, initials } from "@/lib/format";
import type { Settlement } from "@/lib/types";

const EMPTY: Settlement = { total: 0, deliveredCount: 0, averageFee: 0, agencyRate: 0.1, agencyShare: 0, couriers: [] };

export default function ArqueoPage() {
  const { trips } = useTrips();
  const [data, setData] = useState<Settlement>(EMPTY);
  const deliveredCount = trips.filter((t) => t.status === "delivered").length;

  // Se recalcula cada vez que hay una entrega nueva: el cierre se mueve solo
  // mientras la operación corre.
  useEffect(() => {
    fetch("/api/settlement", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, [deliveredCount]);

  const rate = `${Math.round(data.agencyRate * 100)} %`;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      {/* Solo los domicilios de hoy: lo que generaron las motos y la parte de la agencia. */}
      <div className="grid gap-3 sm:grid-cols-[3fr_2fr]">
        <section className="relative overflow-hidden rounded-2xl bg-clapi p-5 text-white shadow-sm lg:p-6">
          <span className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" />
          <span className="absolute -bottom-16 right-16 h-32 w-32 rounded-full bg-white/5" />
          <p className="flex items-center gap-2 text-sm font-medium text-white/80">
            <TrendingUp size={16} /> Total generado hoy
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

      {/* Desglose por moto */}
      <section className="card overflow-hidden">
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

        {data.couriers.length === 0 && <p className="px-5 py-12 text-center text-sm text-ink-3">Todavía no hay entregas cerradas hoy.</p>}
      </section>
    </div>
  );
}
