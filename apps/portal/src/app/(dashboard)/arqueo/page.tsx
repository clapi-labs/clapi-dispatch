"use client";

import { Banknote, CreditCard, TrendingUp, Wallet } from "lucide-react";
import { useEffect, useState } from "react";

import { useTrips } from "@/components/TripsProvider";
import { formatCOP, initials } from "@/lib/format";
import type { Settlement } from "@/lib/types";

const EMPTY: Settlement = {
  netEarnings: 0,
  deliveredCount: 0,
  averageFee: 0,
  byMethod: { cash: { orders: 0, amount: 0 }, transfer: { orders: 0, amount: 0 } },
  couriers: [],
};

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

  const { cash, transfer } = data.byMethod;
  const totalCollected = cash.amount + transfer.amount;
  const cashShare = totalCollected ? Math.round((cash.amount / totalCollected) * 100) : 0;
  const totalCash = data.couriers.reduce((s, c) => s + c.cashToDeliver, 0);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <div>
        <h1 className="text-xl font-bold tracking-tight lg:text-2xl">Finanzas y arqueo</h1>
        <p className="text-sm text-ink-3">Cierre del día, al minuto · {new Date().toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })}</p>
      </div>

      {/* La cifra que importa, grande y en el violeta de CLAPI. */}
      <section className="relative overflow-hidden rounded-2xl bg-clapi p-5 text-white shadow-sm lg:p-6">
        <span className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" />
        <span className="absolute -bottom-16 right-16 h-32 w-32 rounded-full bg-white/5" />
        <p className="flex items-center gap-2 text-sm font-medium text-white/80">
          <TrendingUp size={16} /> Total neto generado
        </p>
        <p className="mt-1 text-4xl font-extrabold tracking-tight tabular-nums lg:text-5xl">{formatCOP(data.netEarnings)}</p>
        <p className="mt-2 text-sm text-white/80">
          {data.deliveredCount} domicilios entregados · promedio {formatCOP(data.averageFee)} por domicilio
        </p>
      </section>

      {/* Desglose por método */}
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Dinero de los pedidos, por método</h2>
        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-sunken">
          <div className="h-full bg-gold" style={{ width: `${cashShare}%` }} />
          <div className="h-full bg-clapi" style={{ width: `${totalCollected ? 100 - cashShare : 0}%` }} />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3 rounded-xl bg-gold-soft p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold text-clapi-deep">
              <Banknote size={19} />
            </span>
            <div>
              <p className="text-xs font-semibold text-gold-ink">Efectivo · {cash.orders} pedidos</p>
              <p className="text-xl font-bold tabular-nums">{formatCOP(cash.amount)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl bg-clapi-soft p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-clapi text-white">
              <CreditCard size={19} />
            </span>
            <div>
              <p className="text-xs font-semibold text-clapi-ink">Pre-pagado / transferencia · {transfer.orders} pedidos</p>
              <p className="text-xl font-bold tabular-nums">{formatCOP(transfer.amount)}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Desglose por moto */}
      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold">Por motorizado</h2>
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <Wallet size={13} /> {formatCOP(totalCash)} por recibir en base
          </span>
        </div>

        <div className="hidden grid-cols-[1fr_7rem_9rem_11rem] gap-4 border-b border-line bg-sunken/60 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3 md:grid">
          <span>Motorizado</span>
          <span className="text-right">Viajes</span>
          <span className="text-right">Ganancia neta</span>
          <span className="text-right">Efectivo a entregar</span>
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
                <span className="block text-[10px] font-semibold uppercase text-ink-3 md:hidden">Ganancia</span>
                <span className="font-semibold tabular-nums text-ok">{formatCOP(row.netEarnings)}</span>
              </span>
              <span className="rounded-lg bg-gold-soft px-2.5 py-1.5 md:bg-transparent md:p-0 md:text-right">
                <span className="block text-[10px] font-semibold uppercase text-gold-ink md:hidden">A entregar</span>
                <span className={`font-bold tabular-nums ${row.cashToDeliver ? "text-gold-ink md:rounded-lg md:bg-gold-soft md:px-2.5 md:py-1" : "text-ink-3"}`}>
                  {formatCOP(row.cashToDeliver)}
                </span>
              </span>
            </div>
          </div>
        ))}

        {data.couriers.length === 0 && <p className="px-5 py-12 text-center text-sm text-ink-3">Todavía no hay entregas cerradas hoy.</p>}
      </section>
    </div>
  );
}
