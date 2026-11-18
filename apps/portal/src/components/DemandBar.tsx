"use client";

import type { DemandConfig, DemandLevel, DemandMetrics, DemandSignal } from "@dispatch/shared/domain/demand";
import { Gauge } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { durationLabel } from "@/lib/format";
import { useLive } from "@/lib/live";
import { useNow } from "@/lib/use-now";

/** Lo que devuelve GET /api/demanda. */
export type DemandData = {
  level: DemandLevel;
  since: string | null;
  measuredAt: string | null;
  pending: { to: DemandLevel; minutesLeft: number } | null;
  now: { metrics: DemandMetrics; signal: DemandSignal; summary: string };
  config: DemandConfig;
  changes:
    | { id: number; level: DemandLevel; previous: DemandLevel; at: string; metrics: DemandMetrics; config: DemandConfig; summary: string }[]
    | null;
};

/** Más viejo que esto, la última medición no es de ahora: el worker no está corriendo. */
export const STALE_MS = 60_000;

export const LEVEL = {
  alta: { label: "Demanda alta", mode: "pico", dot: "bg-warn", tone: "bg-warn-soft text-warn" },
  baja: { label: "Demanda baja", mode: "valle", dot: "bg-ok", tone: "bg-ok-soft text-ok" },
} as const;

/** La demanda en vivo, con o sin el registro de cambios. Se pone al día con
 *  los viajes, las asignaciones y cada cambio de nivel, y cada 15 s por las
 *  motos que se conectan o se desconectan. */
export function useDemand(withLog = false) {
  const [data, setData] = useState<DemandData | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/demanda${withLog ? "?registro=1" : ""}`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setData(await res.json());
  }, [withLog]);
  useLive(refresh, ["trips", "assignments", "demand_state", "demand_changes"]);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 15_000);
    return () => clearInterval(id);
  }, [refresh]);
  return { data, failed, refresh };
}

/** «Sube a alta en 2 min si sigue así». */
export function pendingLabel(pending: DemandData["pending"]) {
  if (!pending) return null;
  const verb = pending.to === "alta" ? "Sube a alta" : "Baja";
  return pending.minutesLeft <= 0 ? `${verb} ya` : `${verb} en ${pending.minutesLeft} min si sigue así`;
}

/**
 * Arriba del tablero de viajes: si la demanda está alta o baja y por qué
 * («Demanda alta: 5 pedidos esperando, 1 moto libre»).
 */
export function DemandBar() {
  const { data } = useDemand();
  const now = useNow(30_000);
  if (!data) return null;

  const level = LEVEL[data.level];
  const stale = !data.measuredAt || now - Date.parse(data.measuredAt) > STALE_MS;
  const pending = pendingLabel(data.pending);
  return (
    <div
      role="status"
      className="card flex min-w-0 items-center gap-3 px-4 py-2.5 text-sm"
      aria-label={`${level.label}: ${data.now.summary}`}
    >
      <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${level.tone}`}>
        <Gauge size={13} /> {level.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-2">
        {data.now.summary}
        {data.since && <span className="text-ink-3"> · hace {durationLabel((now - Date.parse(data.since)) / 1000)}</span>}
        {pending && <span className="font-medium text-ink"> · {pending}</span>}
        {stale && <span className="text-danger"> · sin medir: revisa el worker</span>}
      </span>
    </div>
  );
}
