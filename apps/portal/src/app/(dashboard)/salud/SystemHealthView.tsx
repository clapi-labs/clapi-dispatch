"use client";

import { Activity, Database, HardDrive, Image as ImageIcon, MemoryStick, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DISK_CRITICAL_PCT, DISK_WARNING_PCT, formatBytes, type DiskLevel } from "@dispatch/shared";
import type { SystemHealth } from "@dispatch/shared/db";

/**
 * Salud del sistema (issue #103): qué tan lleno está el disco, cuánto pesa la
 * base y sus tablas más grandes, la carpeta de imágenes y la memoria. Se pone
 * al día sola cada `REFRESH_MS` mientras la pestaña está a la vista. Si el
 * disco pasa del 75 % o del 85 %, además suena en el celular (alertas).
 */

const REFRESH_MS = 30_000;

const LEVEL: Record<DiskLevel, { label: string; tone: string; bar: string }> = {
  ok: { label: "Bien", tone: "bg-ok-soft text-ok", bar: "bg-ok" },
  warning: { label: `Más del ${DISK_WARNING_PCT} %`, tone: "bg-warn-soft text-warn", bar: "bg-warn" },
  critical: { label: `Más del ${DISK_CRITICAL_PCT} %`, tone: "bg-danger-soft text-danger", bar: "bg-danger" },
};

const TABLE_LABEL: Record<string, string> = {
  messages: "Mensajes de los chats",
  engine_evaluations: "Decisiones del algoritmo",
  processed_messages: "Webhooks atendidos",
  trips: "Viajes",
  assignments: "Asignaciones",
  conversations: "Conversaciones",
};

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" });

const days = (n: number | null) => (n === null ? "Sin borrar" : `${n} días`);

function Card({ icon: Icon, title, children }: { icon: typeof Activity; title: string; children: React.ReactNode }) {
  return (
    <section className="card flex flex-col gap-3 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon size={16} className="text-clapi-ink" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-ink-2">
        {label}
        {hint ? <span className="ml-1 text-xs text-ink-3">{hint}</span> : null}
      </span>
      <span className="shrink-0 font-medium tabular-nums">{value}</span>
    </div>
  );
}

function Meter({ pct, bar }: { pct: number; bar: string }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-sunken" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

export function SystemHealthView() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/system-health", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Solo administradores" : `Error ${res.status}`);
      setHealth((await res.json()) as SystemHealth);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo medir");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const every = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const disk = health?.disk ?? null;
  const level = disk ? LEVEL[disk.level] : null;
  const mem = health?.memory;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <header className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-clapi-soft text-clapi-ink">
          <Activity size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">Salud del sistema</h1>
          <p className="text-sm text-ink-3">
            Disco, base de datos y memoria del servidor. {health ? `Medido ${dateTime(health.at)}.` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-2 hover:bg-sunken disabled:opacity-50"
          aria-label="Volver a medir"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      {error ? (
        <p role="alert" className="flex items-center gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          <TriangleAlert size={16} /> {error}
        </p>
      ) : null}

      {health?.errors.length ? (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">No se pudo medir: {health.errors.join(" · ")}</p>
      ) : null}

      {disk && level ? (
        <Card icon={HardDrive} title="Disco del servidor">
          {disk.level !== "ok" ? (
            <p role="status" className={`rounded-xl px-4 py-3 text-sm font-medium ${level.tone}`}>
              {disk.level === "critical"
                ? "El disco está casi lleno: hay que liberar espacio ya. Si se llena, se detienen los chats y la base."
                : "El disco pasó el 75 %: conviene revisar qué está creciendo."}
            </p>
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-2xl font-semibold tabular-nums">{disk.usedPct.toString().replace(".", ",")} %</span>
            <span className={`rounded-lg px-2 py-0.5 text-xs font-medium ${level.tone}`}>{level.label}</span>
          </div>
          <Meter pct={disk.usedPct} bar={level.bar} />
          <Row label="Usado" value={formatBytes(disk.used)} />
          <Row label="Libre" value={formatBytes(disk.free)} />
          <Row label="Total" value={formatBytes(disk.total)} />
          <p className="text-xs text-ink-3">
            Avisa al celular desde el {DISK_WARNING_PCT} % (advertencia) y el {DISK_CRITICAL_PCT} % (crítico).
          </p>
        </Card>
      ) : null}

      {health?.database ? (
        <Card icon={Database} title="Base de datos">
          <Row label="Tamaño total" value={formatBytes(health.database.bytes)} />
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-sunken text-left text-xs text-ink-3">
                <tr>
                  <th className="px-3 py-2 font-medium">Tabla</th>
                  <th className="px-3 py-2 text-right font-medium">Filas (aprox.)</th>
                  <th className="px-3 py-2 text-right font-medium">Peso</th>
                </tr>
              </thead>
              <tbody>
                {health.database.tables.map((t) => (
                  <tr key={t.name} className="border-t border-line">
                    <td className="px-3 py-2">
                      <span className="block">{TABLE_LABEL[t.name] ?? t.name}</span>
                      <span className="font-mono text-[11px] text-ink-3">{t.name}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.rows.toLocaleString("es-CO")}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatBytes(t.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            <p className="text-xs font-medium text-ink-3">Se borra solo (una vez por hora)</p>
            <Row label="Mensajes de los chats" value={days(health.retention.messagesDays)} />
            <Row label="Decisiones del algoritmo" value={days(health.retention.engineEvaluationsDays)} />
            <Row label="Webhooks atendidos" value={days(health.retention.processedMessagesDays)} />
            <Row label="Viajes y asignaciones" value="Nunca" />
          </div>
        </Card>
      ) : null}

      {health ? (
        <Card icon={ImageIcon} title="Imágenes de los chats">
          {health.media.exists ? (
            <>
              <Row label="Peso" value={formatBytes(health.media.bytes)} />
              <Row label="Archivos" value={`${health.media.files.toLocaleString("es-CO")}${health.media.truncated ? "+" : ""}`} />
              <Row label="La más antigua" value={health.media.oldest ? dateTime(health.media.oldest) : "—"} />
            </>
          ) : (
            <p className="text-sm text-ink-3">
              {health.media.dir ? `Todavía no existe la carpeta ${health.media.dir}.` : "Las imágenes todavía no se guardan en el servidor (MEDIA_DIR sin configurar)."}
            </p>
          )}
        </Card>
      ) : null}

      {mem ? (
        <Card icon={MemoryStick} title="Memoria">
          <Row label="Servidor" value={`${formatBytes(mem.system.total - mem.system.free)} de ${formatBytes(mem.system.total)}`} hint="en uso" />
          {mem.container ? (
            <Row
              label="Contenedor del portal"
              value={mem.container.limit ? `${formatBytes(mem.container.used)} de ${formatBytes(mem.container.limit)}` : formatBytes(mem.container.used)}
            />
          ) : null}
          <Row label="Proceso del portal" value={formatBytes(mem.processRss)} />
          <p className="text-xs text-ink-3">
            El detalle por contenedor (bot, Postgres, OSRM…) se ve en el servidor con <code className="font-mono">docker stats</code>.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
