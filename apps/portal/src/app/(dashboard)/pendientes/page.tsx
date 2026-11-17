"use client";

import { datafonoLateAt, groupDebts, joinCodes } from "@dispatch/shared/domain/return-debts";
import { sameRestaurant } from "@dispatch/shared";
import { AlertCircle, Check, Clock, CreditCard, Plus, Send, Wallet } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { ConfirmDialog, Modal } from "@/components/Modal";
import { durationLabel, timeOfDay } from "@/lib/format";
import { useLive } from "@/lib/live";
import type { Courier, ReturnDebt, ReturnDebtClaim, ReturnDebtsData } from "@/lib/types";
import { useNow } from "@/lib/use-now";

type Restaurant = { id: number; name: string; active: boolean };

/** Lo que llega por JSON, con las fechas como `Date` para agrupar y medir. */
type DebtRow = Omit<ReturnDebt, "createdAt" | "deliveredAt"> & { createdAt: Date; deliveredAt: Date | null };

const toRow = (d: ReturnDebt): DebtRow => ({ ...d, createdAt: new Date(d.createdAt), deliveredAt: d.deliveredAt ? new Date(d.deliveredAt) : null });

const REASON = {
  datafono: { label: "Datáfono", icon: CreditCard, tone: "bg-clapi-soft text-clapi-ink" },
  plata: { label: "Plata", icon: Wallet, tone: "bg-gold-soft text-gold-ink" },
} as const;

/**
 * Pendientes de regreso (docs/FLUJO-DOMICILIARIO.md, «Pendientes de regreso»):
 * quién le debe qué a qué restaurante y desde cuándo. Lo declara el
 * domiciliario al recoger; la central puede registrar uno a mano, pedirle que
 * pase por el restaurante («Mandar ya») o marcarlo resuelto. No hay montos: la
 * agencia no maneja esa plata.
 */
export default function PendientesPage() {
  const [data, setData] = useState<ReturnDebtsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState<{ restaurantId?: number | null; reason?: "datafono" | "plata" } | null>(null);
  const [resolving, setResolving] = useState<{ id: number; title: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useNow(30_000);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/pendientes", { cache: "no-store" });
    if (!res.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setData(await res.json());
  }, []);
  useLive(refresh, ["return_debts", "return_debt_claims", "trips", "assignments"]);

  const groups = useMemo(() => groupDebts((data?.open ?? []).map(toRow)), [data]);
  const claims = data?.claims ?? [];
  const history = data?.resolved ?? [];

  function flash(text: string) {
    setNotice(text);
    setTimeout(() => setNotice(null), 4000);
  }

  async function act(id: number, action: "resolve" | "nudge" | "handle_claim") {
    const res = await fetch(`/api/pendientes/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) flash(body.error ?? "No se pudo.");
    else flash(action === "nudge" ? "Le llegó el mensaje al domiciliario." : action === "handle_claim" ? "Reclamo marcado como atendido." : "Quedó resuelto.");
    refresh();
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Pendientes de regreso</h1>
          <p className="text-sm text-ink-3">Lo que cada domiciliario tiene que devolverle o pagarle a un restaurante. Sin montos: solo quién, a quién, por qué y desde cuándo.</p>
        </div>
        <button
          type="button"
          onClick={() => setAdding({})}
          className="ease-ui flex h-11 items-center gap-2 rounded-xl bg-clapi px-4 text-sm font-semibold text-white shadow-sm can-hover:hover:brightness-110"
        >
          <Plus size={16} /> Registrar pendiente
        </button>
      </div>

      {notice && <p className="rounded-xl bg-clapi-soft px-4 py-2.5 text-sm font-medium text-clapi-ink">{notice}</p>}
      {failed && <p className="rounded-xl bg-danger-soft px-4 py-2.5 text-sm text-danger">No se pudieron leer los pendientes. Se reintenta solo.</p>}

      {claims.length > 0 && (
        <section className="card overflow-hidden border border-danger/30">
          <div className="flex items-center gap-2 border-b border-line bg-danger-soft/40 px-5 py-3.5 text-sm font-semibold text-danger">
            <AlertCircle size={16} /> Reclamos por atender ({claims.length})
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {claims.map((c: ReturnDebtClaim) => {
              const matching = groups.filter((g) => sameRestaurant(c, g) && (!c.reason || g.reason === c.reason));
              const label = c.reason ? REASON[c.reason].label : "Pendiente";
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5">
                  <span className="flex items-center gap-1.5 rounded-full bg-danger px-2.5 py-1 text-xs font-semibold text-white">
                    {label}
                    {c.closing ? " · Cierra" : ""}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{c.restaurantName}</p>
                    <p className="text-xs text-ink-3">
                      {c.why} · reclamado a las {timeOfDay(c.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {matching.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => act(matching[0].debts[0].id, "nudge")}
                        className="ease-ui flex h-9 items-center gap-1.5 rounded-xl bg-sunken px-3 text-xs font-semibold text-ink-2 can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink"
                      >
                        <Send size={13} /> Mandar ya
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAdding({ restaurantId: c.restaurantId, reason: c.reason ?? "datafono" })}
                        className="ease-ui flex h-9 items-center gap-1.5 rounded-xl bg-sunken px-3 text-xs font-semibold text-ink-2 can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink"
                      >
                        <Plus size={13} /> Registrar pendiente
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => act(c.id, "handle_claim")}
                      className="ease-ui flex h-9 items-center gap-1.5 rounded-xl bg-clapi-soft px-3 text-xs font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
                    >
                      <Check size={13} /> Lo resuelvo yo
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
          Abiertos ({groups.length})
          {data && <AlertMinutes minutes={data.datafonoAlertMinutes} onSaved={(m) => (flash(`El aviso del datáfono sale a los ${m} min.`), refresh())} />}
        </div>
        {data === null ? (
          <p className="px-5 py-12 text-center text-sm text-ink-3">Cargando…</p>
        ) : groups.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-3">Nadie tiene pendientes de regreso.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {groups.map((g) => {
              const reason = REASON[g.reason];
              const Icon = reason.icon;
              const lateAt = g.debts.map((d) => datafonoLateAt(d, data.datafonoAlertMinutes)).filter((d): d is Date => d !== null);
              const late = lateAt.some((d) => d.getTime() <= now);
              const courier = g.debts[0].courierName;
              const byCentral = g.debts.some((d) => d.declaredBy === "central");
              const claimed = g.debts.map((d) => d.claimedAt).filter(Boolean).sort().pop();
              const reminded = g.debts.map((d) => d.reminderAt).filter(Boolean).sort().pop();
              const waiting = g.reason === "datafono" && g.debts.every((d) => d.tripId !== null && d.deliveredAt === null);
              return (
                <li key={g.key} className={`flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5 ${late ? "bg-danger-soft/50" : ""}`}>
                  <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${late ? "bg-danger text-white" : reason.tone}`}>
                    <Icon size={13} /> {reason.label}
                    {g.debts.length > 1 ? ` × ${g.debts.length}` : ""}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {courier} <span className="font-normal text-ink-3">→</span> {g.restaurantName}
                    </p>
                    <p className="text-xs text-ink-3">
                      {joinCodes(g.debts.map((d) => d.tripCode)) || "Sin pedido"} · <Clock size={11} className="inline" /> hace {durationLabel((now - g.since.getTime()) / 1000)}
                      {waiting ? " · todavía lleva el pedido" : ""}
                      {late ? " · el datáfono no ha vuelto" : ""}
                      {byCentral ? " · registrado por la central" : ""}
                      {claimed ? ` · Reclamado a las ${timeOfDay(claimed)}, avisado automáticamente` : reminded ? ` · avisado a las ${timeOfDay(reminded)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => act(g.debts[0].id, "nudge")}
                      className="ease-ui flex h-9 items-center gap-1.5 rounded-xl bg-sunken px-3 text-xs font-semibold text-ink-2 can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink"
                    >
                      <Send size={13} /> Mandar ya
                    </button>
                    <button
                      type="button"
                      onClick={() => setResolving({ id: g.debts[0].id, title: `${courier} → ${g.restaurantName}: ${reason.label.toLowerCase()}` })}
                      className="ease-ui flex h-9 items-center gap-1.5 rounded-xl bg-clapi-soft px-3 text-xs font-semibold text-clapi-ink can-hover:hover:bg-clapi can-hover:hover:text-white"
                    >
                      <Check size={13} /> Resuelto
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-line px-5 py-4 text-sm font-semibold">Historial (últimos 7 días)</div>
        {history.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-3">Todavía no se ha cerrado ninguno.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-5 py-2 font-medium">Domiciliario</th>
                  <th className="px-3 py-2 font-medium">Restaurante</th>
                  <th className="px-3 py-2 font-medium">Motivo</th>
                  <th className="px-3 py-2 font-medium">Pedido</th>
                  <th className="px-3 py-2 font-medium">Desde</th>
                  <th className="px-5 py-2 font-medium">Cerrado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.map((d) => (
                  <tr key={d.id}>
                    <td className="px-5 py-2">{d.courierName}</td>
                    <td className="px-3 py-2">{d.restaurantName}</td>
                    <td className="px-3 py-2">{REASON[d.reason].label}</td>
                    <td className="px-3 py-2 tabular-nums">{d.tripCode ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums text-ink-2">{timeOfDay(d.createdAt)}</td>
                    <td className="px-5 py-2 text-ink-2">
                      {d.resolvedAt ? timeOfDay(d.resolvedAt) : ""} · {d.resolvedBy === "courier" ? "el domiciliario" : (d.resolvedByName ?? "la central")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {adding && (
        <AddDebtDialog
          initialRestaurantId={adding.restaurantId ?? null}
          initialReason={adding.reason ?? "datafono"}
          onClose={() => setAdding(null)}
          onSaved={() => (flash("Quedó registrado."), refresh())}
        />
      )}
      {resolving && (
        <ConfirmDialog
          title={`¿Marcar resuelto? ${resolving.title}`}
          points={["Se cierran todos los de ese domiciliario, restaurante y motivo.", "Pasan al historial con tu nombre."]}
          confirmLabel="Sí, resuelto"
          tone="primary"
          onConfirm={() => act(resolving.id, "resolve")}
          onClose={() => setResolving(null)}
        />
      )}
    </div>
  );
}

/** Los minutos del aviso al celular por un datáfono que no ha vuelto. */
function AlertMinutes({ minutes, onSaved }: { minutes: number; onSaved: (m: number) => void }) {
  const [value, setValue] = useState(String(minutes));
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== String(minutes);

  async function save() {
    const res = await fetch("/api/pendientes", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datafonoAlertMinutes: Number(value) }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "No se pudo guardar");
      return;
    }
    setError(null);
    onSaved(body.datafonoAlertMinutes);
  }

  return (
    <label className="ml-auto flex flex-wrap items-center gap-2 text-xs font-normal text-ink-3">
      Avisar si un datáfono lleva
      <input
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 4))}
        aria-label="Minutos del aviso del datáfono"
        className="h-8 w-14 rounded-lg bg-sunken px-2 text-right text-sm font-semibold text-ink outline-none focus:ring-2 focus:ring-clapi/30"
      />
      min afuera
      {dirty && (
        <button type="button" onClick={save} className="ease-ui h-8 rounded-lg bg-clapi px-3 text-xs font-semibold text-white">
          Guardar
        </button>
      )}
      {error && <span className="text-danger">{error}</span>}
    </label>
  );
}

/** Registrar uno a mano: el domiciliario no lo declaró y el restaurante reclama. */
function AddDebtDialog({
  initialRestaurantId = null,
  initialReason = "datafono",
  onClose,
  onSaved,
}: {
  initialRestaurantId?: number | null;
  initialReason?: "datafono" | "plata";
  onClose: () => void;
  onSaved: () => void;
}) {
  const [couriers, setCouriers] = useState<Courier[] | null>(null);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [courierId, setCourierId] = useState("");
  const [reason, setReason] = useState<"datafono" | "plata">(initialReason);
  const [tripCode, setTripCode] = useState("");
  const [restaurantId, setRestaurantId] = useState(initialRestaurantId ? String(initialRestaurantId) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useLive(
    useCallback(async () => {
      const [c, r] = await Promise.all([fetch("/api/couriers", { cache: "no-store" }), fetch("/api/restaurants", { cache: "no-store" })]);
      if (c.ok) setCouriers(await c.json());
      if (r.ok) setRestaurants(((await r.json()) as Restaurant[]).filter((x) => x.active));
    }, []),
    ["couriers"],
  );

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/pendientes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courierId: Number(courierId), reason, tripCode: tripCode.trim() || undefined, restaurantId: restaurantId ? Number(restaurantId) : undefined }),
    });
    setSaving(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "No se pudo registrar");
      return;
    }
    onClose();
    onSaved();
  }

  const field = "h-10 w-full rounded-xl bg-sunken px-3 text-sm outline-none focus:ring-2 focus:ring-clapi/30";
  return (
    <Modal label="Registrar pendiente" onClose={onClose}>
      <p className="text-base font-semibold text-ink">Registrar pendiente</p>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
        Domiciliario
        <select value={courierId} onChange={(e) => setCourierId(e.target.value)} className={field}>
          <option value="">{couriers === null ? "Cargando…" : "Elegir"}</option>
          {(couriers ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        {(["datafono", "plata"] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setReason(r)}
            aria-pressed={reason === r}
            className={`ease-ui h-10 flex-1 rounded-xl text-sm font-semibold ${reason === r ? "bg-clapi text-white" : "bg-sunken text-ink-2"}`}
          >
            {r === "datafono" ? "Datáfono" : "Plata"}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
        Pedido (opcional: el restaurante sale de ahí)
        <input value={tripCode} onChange={(e) => setTripCode(e.target.value)} placeholder="Ej.: A-12" className={field} />
      </label>
      {!tripCode.trim() && (
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
          Restaurante
          <select value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)} className={field}>
            <option value="">Elegir</option>
            {restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="mt-1 flex gap-2">
        <button type="button" onClick={onClose} className="ease-ui h-10 flex-1 rounded-xl bg-sunken text-sm font-semibold text-ink-2">
          Cancelar
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || !courierId || (!tripCode.trim() && !restaurantId)}
          className="ease-ui h-10 flex-1 rounded-xl bg-clapi text-sm font-semibold text-white disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Registrar"}
        </button>
      </div>
    </Modal>
  );
}
