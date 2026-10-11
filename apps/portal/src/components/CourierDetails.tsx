"use client";

import { Pencil, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { PhoneLink } from "@/components/PhoneLink";
import { useTrips } from "@/components/TripsProvider";
import { durationLabel, elapsedLabel } from "@/lib/format";
import type { Courier, CourierProfile } from "@/lib/types";
import { useNow } from "@/lib/use-now";

type Draft = Record<keyof CourierProfile, string>;

const FIELDS: { key: keyof CourierProfile; label: string; placeholder: string; max: number; inputMode?: "numeric" | "tel"; wide?: boolean }[] = [
  { key: "vehiclePlate", label: "Placa", placeholder: "ABC12D", max: 12 },
  { key: "vehicleType", label: "Moto", placeholder: "Marca y modelo", max: 60 },
  { key: "documentId", label: "Cédula", placeholder: "Número de cédula", max: 20, inputMode: "numeric", wide: true },
  { key: "emergencyContactName", label: "Contacto de emergencia", placeholder: "Nombre", max: 60 },
  { key: "emergencyContactPhone", label: "Teléfono del contacto", placeholder: "3001234567", max: 20, inputMode: "tel" },
];

function Heading({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">{children}</p>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children || <span className="font-normal text-ink-3">Sin registrar</span>}</dd>
    </div>
  );
}

function ProfileForm({ profile, onSave, onCancel }: { profile: CourierProfile; onSave: (draft: Draft) => Promise<boolean>; onCancel: () => void }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.key, profile[f.key] ?? ""])) as Draft);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailed(false);
    // Si guardó, quien lo abrió ya cerró este formulario: solo queda algo que pintar si falló.
    if (await onSave(draft)) return;
    setBusy(false);
    setFailed(true);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {FIELDS.map((f) => (
          <label key={f.key} className={`flex min-w-0 flex-col gap-1 ${f.wide ? "col-span-2" : ""}`}>
            <span className="truncate text-[11px] text-ink-3">{f.label}</span>
            <input
              value={draft[f.key]}
              onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              maxLength={f.max}
              inputMode={f.inputMode}
              className={`ease-ui h-10 min-w-0 rounded-xl bg-sunken px-3 outline-none focus:ring-2 focus:ring-clapi/40 ${
                f.key === "vehiclePlate" ? "uppercase placeholder:normal-case" : ""
              }`}
            />
          </label>
        ))}
      </div>
      {failed && <p className="rounded-lg bg-danger-soft px-3 py-2 text-danger">No se pudo guardar. Intenta de nuevo.</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="ease-ui h-10 flex-1 rounded-xl bg-client text-sm font-semibold text-white disabled:opacity-50">
          Guardar
        </button>
        <button type="button" onClick={onCancel} className="ease-ui h-10 rounded-xl bg-sunken px-4 text-sm font-semibold text-ink-2">
          Cancelar
        </button>
      </div>
    </form>
  );
}

/**
 * Lo que se despliega con "Ver más" en la tarjeta de Flota. El viaje en curso
 * y el ritmo salen de los viajes que el portal ya tiene cargados; el vehículo
 * y los datos personales se piden recién acá, al abrir, para que una flota
 * grande no cargue la ficha de todos en cada sondeo.
 */
export function CourierDetails({ courier }: { courier: Courier }) {
  const { trips, loaded } = useTrips();
  const now = new Date(useNow(30_000));
  const [profile, setProfile] = useState<CourierProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/couriers/${courier.id}/profile`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: CourierProfile) => {
        if (cancelled) return;
        setProfile(data);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [courier.id, attempt]);

  async function save(draft: Draft) {
    const res = await fetch(`/api/couriers/${courier.id}/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }).catch(() => null);
    if (!res?.ok) return false;
    setProfile(await res.json());
    setEditing(false);
    return true;
  }

  const mine = trips.filter((t) => t.courierId === courier.id);
  const current = mine.find((t) => t.status === "en_route" || t.status === "assigned");
  // De asignado a entregado: lo que le toma un viaje completo.
  const times = mine.flatMap((t) => (t.status === "delivered" && t.assignedAt && t.deliveredAt ? [Date.parse(t.deliveredAt) - Date.parse(t.assignedAt)] : []));
  const average = times.length > 0 ? times.reduce((sum, ms) => sum + ms, 0) / times.length / 1000 : null;

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4 text-xs">
      <section>
        <Heading>Viaje en curso</Heading>
        {!loaded ? (
          <p className="animate-pulse text-ink-3">Cargando…</p>
        ) : current ? (
          <div className="rounded-xl bg-clapi-soft px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-clapi-ink">
              <span className="font-mono font-semibold">{current.code}</span>
              {current.assignedAt && <span className="font-medium tabular-nums">{elapsedLabel(new Date(current.assignedAt), now)} en la calle</span>}
            </div>
            <p className="mt-1 truncate font-semibold">{current.originRestaurantName}</p>
            <p className="truncate text-ink-2">{current.deliveryAddress}</p>
          </div>
        ) : (
          <p className="text-ink-3">Sin viaje en curso</p>
        )}
      </section>

      <section>
        <Heading>Ritmo</Heading>
        <dl>
          <Row label="Promedio por entrega">
            {average !== null ? `${durationLabel(average)} · ${times.length} ${times.length === 1 ? "entrega" : "entregas"}` : <span className="font-normal text-ink-3">Sin entregas todavía</span>}
          </Row>
          <Row label="Último viaje recibido">
            {courier.lastAssignedAt ? `hace ${elapsedLabel(new Date(courier.lastAssignedAt), now)}` : <span className="font-normal text-ink-3">Aún no recibe viajes</span>}
          </Row>
        </dl>
      </section>

      {failed ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-danger-soft px-3 py-2 text-danger">
          No se pudo cargar la ficha.
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
            className="flex shrink-0 items-center gap-1 font-semibold"
          >
            <RotateCcw size={12} /> Reintentar
          </button>
        </div>
      ) : !profile ? (
        <p className="animate-pulse text-ink-3">Cargando ficha…</p>
      ) : editing ? (
        <ProfileForm profile={profile} onSave={save} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <section>
            <Heading>Vehículo</Heading>
            <dl>
              <Row label="Placa">{profile.vehiclePlate && <span className="font-mono">{profile.vehiclePlate}</span>}</Row>
              <Row label="Moto">{profile.vehicleType}</Row>
            </dl>
          </section>

          <section>
            <Heading>Datos personales</Heading>
            <dl>
              <Row label="Cédula">{profile.documentId}</Row>
              <Row label="Contacto de emergencia">{profile.emergencyContactName}</Row>
              <Row label="Teléfono del contacto">
                {profile.emergencyContactPhone && (
                  <PhoneLink phone={profile.emergencyContactPhone} name={profile.emergencyContactName ?? `Contacto de ${courier.name}`} />
                )}
              </Row>
            </dl>
          </section>

          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ease-ui flex h-9 items-center justify-center gap-1.5 rounded-lg bg-sunken font-semibold text-ink-2 can-hover:hover:bg-clapi-soft can-hover:hover:text-clapi-ink"
          >
            <Pencil size={13} /> Editar datos
          </button>
        </>
      )}
    </div>
  );
}
