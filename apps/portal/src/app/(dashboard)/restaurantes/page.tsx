"use client";

import { googleMapsLink, inServiceArea, parseCoordinates } from "@dispatch/shared/domain/coordinates";
import { formatClock, type ServiceHours } from "@dispatch/shared/domain/service-hours";
import { Check, Clock, ExternalLink, Info, MapPin, Pencil, Plus, Search, Store, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ConfirmDialog } from "@/components/Modal";
import { PhotoButton } from "@/components/PhotoButton";
import { ServiceHoursCard } from "@/components/ServiceHoursCard";

type Restaurant = {
  id: number;
  name: string;
  phone: string | null;
  photo: string | null;
  knownPickupAddress: string | null;
  knownPickupLocation: { lat: number; lng: number } | null;
  pickupDetail: string | null;
  /** "HH:MM"; null: usa la hora límite por defecto. */
  orderDeadline: string | null;
  active: boolean;
};

/** El formulario, como texto mientras se escribe. `coords` es lo que se pegó de Google Maps. */
type Form = { name: string; phone: string; address: string; detail: string; coords: string; deadline: string; active: boolean };

const EMPTY: Form = { name: "", phone: "", address: "", detail: "", coords: "", deadline: "", active: true };

function toForm(r: Restaurant): Form {
  return {
    name: r.name,
    phone: !r.phone ? "" : r.phone.startsWith("57") && r.phone.length === 12 ? r.phone.slice(2) : r.phone,
    address: r.knownPickupAddress ?? "",
    detail: r.pickupDetail ?? "",
    coords: r.knownPickupLocation ? `${r.knownPickupLocation.lat}, ${r.knownPickupLocation.lng}` : "",
    deadline: r.orderDeadline ?? "",
    active: r.active,
  };
}

/** Qué se entendió de lo pegado en "Coordenadas". */
function readCoords(text: string) {
  if (!text.trim()) return { kind: "empty" as const };
  const point = parseCoordinates(text);
  if (!point) {
    const short = /goo\.gl|maps\.app/i.test(text);
    return {
      kind: "error" as const,
      message: short
        ? "Los enlaces cortos no traen las coordenadas. Copia los números del clic derecho sobre el local."
        : "No son coordenadas. Copia los números del clic derecho sobre el local, como 3.37261, -76.53012.",
    };
  }
  if (!inServiceArea(point)) {
    const swapped = { lat: point.lng, lng: point.lat };
    return {
      kind: "error" as const,
      message: inServiceArea(swapped)
        ? "Parecen estar al revés: primero va el 3.xx y después el -76.xx."
        : "Ese punto queda fuera de Cali y Jamundí. Revisa que sea el local correcto.",
    };
  }
  return { kind: "ok" as const, point };
}

function formatPhone(phone: string) {
  const local = phone.startsWith("57") && phone.length === 12 ? phone.slice(2) : phone;
  return local.length === 10 ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : phone;
}

const input =
  "ease-ui h-11 w-full min-w-0 rounded-xl bg-sunken px-3.5 text-sm outline-none focus:ring-2 focus:ring-clapi/40";

/**
 * Restaurantes: quién pide domicilios y dónde se recoge. El bot reconoce al
 * restaurante por su número de WhatsApp y cobra desde estas coordenadas, que
 * se copian de Google Maps (el punto exacto del local, sin geocodificar).
 */
export default function RestaurantesPage() {
  const [list, setList] = useState<Restaurant[] | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  /** null: formulario cerrado; "new": uno nuevo; número: editando ese. */
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Restaurant | null>(null);
  const [hours, setHours] = useState<ServiceHours | null>(null);

  async function setPhoto(id: number, photo: string | null) {
    const res = await fetch(`/api/restaurants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo }),
    });
    if (!res.ok) throw new Error("No se guardó");
    setList((prev) => prev?.map((r) => (r.id === id ? { ...r, photo } : r)) ?? null);
  }

  async function remove(id: number) {
    setList((prev) => prev?.filter((r) => r.id !== id) ?? null);
    if (editing === id) setEditing(null);
    await fetch(`/api/restaurants/${id}`, { method: "DELETE" });
    load();
  }

  function load() {
    return fetch("/api/restaurants", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Restaurant[] | null) => {
        if (data) setList(data);
      });
  }

  useEffect(() => {
    fetch("/api/service-hours", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ServiceHours | null) => {
        if (data) setHours(data);
      });
    fetch("/api/restaurants", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Restaurant[] | null) => {
        if (data) setList(data);
      });
  }, []);

  const filtered = useMemo(() => {
    if (!list) return [];
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    if (!q) return list;
    return list.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.knownPickupAddress ?? "").toLowerCase().includes(q) ||
        (digits.length >= 3 && !!r.phone?.includes(digits)),
    );
  }, [list, query]);

  const coords = readCoords(form.coords);
  const canSave =
    form.name.trim() !== "" && (form.phone.trim() === "" || form.phone.replace(/\D/g, "").length >= 10) && form.address.trim() !== "" && coords.kind === "ok";

  function open(target: Restaurant | "new") {
    setEditing(target === "new" ? "new" : target.id);
    setForm(target === "new" ? EMPTY : toForm(target));
    setError(null);
    setSavedName(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function set(patch: Partial<Form>) {
    setForm((prev) => ({ ...prev, ...patch }));
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave || coords.kind !== "ok" || editing === null) return;
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      phone: form.phone,
      pickupAddress: form.address,
      pickupDetail: form.detail,
      pickupLocation: coords.point,
      orderDeadline: form.deadline,
      active: form.active,
    };
    const res = await fetch(editing === "new" ? "/api/restaurants" : `/api/restaurants/${editing}`, {
      method: editing === "new" ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      setError(data?.error ?? "No se pudo guardar. Intenta de nuevo.");
      return;
    }
    setSavedName(form.name.trim());
    setEditing(null);
    setForm(EMPTY);
    load();
    setTimeout(() => setSavedName(null), 3000);
  }

  /** Abre Google Maps buscando el nombre, para copiar de ahí la dirección y las coordenadas. */
  const mapsSearch = `https://www.google.com/maps/search/${encodeURIComponent(`${form.name.trim() || "restaurante"} Cali`)}`;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
      <div className="flex items-center gap-2">
        <label className="ease-ui flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl bg-sunken px-3.5 focus-within:ring-2 focus-within:ring-clapi/30">
          <Search size={16} className="shrink-0 text-ink-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearching(true)}
            onBlur={() => setSearching(false)}
            placeholder="Buscar por nombre, dirección o número"
            className="w-full min-w-0 bg-transparent text-sm outline-none"
          />
        </label>
        {/* Mientras se busca queda solo el ícono, y el buscador se queda con el espacio. */}
        <button
          type="button"
          onClick={() => open("new")}
          aria-label="Agregar restaurante"
          title="Agregar restaurante"
          className="ease-ui flex h-11 shrink-0 items-center rounded-xl bg-clapi px-3.5 text-sm font-semibold text-white shadow-sm can-hover:hover:brightness-110"
        >
          <Plus size={17} className="shrink-0" />
          <span
            className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ease-out ${
              searching || query !== "" ? "max-w-0 opacity-0" : "ml-2 max-w-24 opacity-100"
            }`}
          >
            Agregar
          </span>
        </button>
      </div>

      {savedName && (
        <p className="-mt-2 flex items-center gap-1.5 text-sm text-ok">
          <Check size={16} /> {savedName} guardado
        </p>
      )}

      {hours && <ServiceHoursCard hours={hours} onSaved={setHours} />}

      {editing !== null && (
        <form onSubmit={save} className="card grid gap-5 p-4 sm:p-5 lg:grid-cols-[1.3fr_1fr]">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Store size={16} className="text-clapi" />
              {editing === "new" ? "Nuevo restaurante" : "Editar restaurante"}
              <button
                type="button"
                onClick={() => setEditing(null)}
                aria-label="Cerrar"
                className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-ink-3 can-hover:hover:bg-sunken"
              >
                <X size={18} />
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nombre">
                <input autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Monkeys Valle del Lili" className={input} />
              </Field>
              <Field label="WhatsApp del restaurante (opcional)">
                <input
                  value={form.phone}
                  onChange={(e) => set({ phone: e.target.value })}
                  inputMode="tel"
                  placeholder="3001234567"
                  className={input}
                />
              </Field>
            </div>

            <Field label="Dirección (copiada de Google Maps)">
              <input
                value={form.address}
                onChange={(e) => set({ address: e.target.value })}
                placeholder="Cra. 98 #16-50, Valle del Lili"
                className={input}
              />
            </Field>

            <Field label="Detalle para el motorizado (opcional)">
              <input
                value={form.detail}
                onChange={(e) => set({ detail: e.target.value })}
                placeholder="Local 12, entrada por el parqueadero"
                className={input}
              />
            </Field>

            <Field label="Coordenadas (clic derecho sobre el local en Google Maps)">
              <input
                value={form.coords}
                onChange={(e) => set({ coords: e.target.value })}
                placeholder="3.37261, -76.53012"
                className={`${input} font-mono ${coords.kind === "error" ? "ring-2 ring-danger/60" : ""}`}
              />
            </Field>
            {coords.kind === "error" && <p className="-mt-1 text-xs text-danger">{coords.message}</p>}
            {coords.kind === "ok" && (
              <a
                href={googleMapsLink(coords.point)}
                target="_blank"
                rel="noreferrer"
                className="-mt-1 flex w-fit items-center gap-1.5 text-xs font-semibold text-clapi-ink can-hover:hover:underline"
              >
                <MapPin size={14} /> {coords.point.lat}, {coords.point.lng} · Ver en Google Maps que sea el local
                <ExternalLink size={12} />
              </a>
            )}

            <Field label="Hora límite para pedir (opcional)">
              <div className="flex items-center gap-2">
                <input type="time" value={form.deadline} onChange={(e) => set({ deadline: e.target.value })} className={`${input} sm:max-w-44`} />
                {form.deadline && (
                  <button
                    type="button"
                    onClick={() => set({ deadline: "" })}
                    className="ease-ui h-11 shrink-0 rounded-xl px-3 text-xs font-semibold text-ink-2 can-hover:hover:bg-sunken"
                  >
                    Usar la de por defecto
                  </button>
                )}
              </div>
            </Field>
            <p className="-mt-1 text-xs text-ink-3">
              {form.deadline
                ? `Recibe servicios hasta las ${formatClock(form.deadline)}${form.deadline < (hours?.opensAt ?? "10:00") ? ", pasada la medianoche" : ""}.`
                : `Vacía: usa la hora límite por defecto${hours ? ` (${formatClock(hours.defaultDeadline)})` : ""}.`}
            </p>

            <label className="flex w-fit items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} className="h-4 w-4 accent-clapi" />
              Activo (si no, el bot lo trata como un número desconocido)
            </label>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={!canSave || saving}
                className="ease-ui flex h-11 items-center gap-2 rounded-xl bg-clapi px-5 text-sm font-semibold text-white shadow-sm disabled:opacity-40"
              >
                {saving ? "Guardando…" : "Guardar"}
              </button>
              {error && <p className="text-sm text-danger">{error}</p>}
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl bg-gold-soft p-4 text-sm text-gold-ink">
            <p className="flex items-center gap-2 font-semibold">
              <Info size={16} /> Cómo sacar los datos de Google Maps
            </p>
            <ol className="flex list-decimal flex-col gap-2 pl-5">
              <li>
                <a href={mapsSearch} target="_blank" rel="noreferrer" className="font-semibold underline">
                  Busca el restaurante en Google Maps
                </a>{" "}
                por su nombre y abre su ficha.
              </li>
              <li>
                <b>Dirección:</b> la que sale en la ficha, debajo del nombre. Cópiala tal cual.
              </li>
              <li>
                <b>Coordenadas:</b> clic derecho exactamente sobre el pin del local. La primera línea del menú son los
                números; haz clic en ellos y se copian. En el celular: mantén presionado el local y cópialos del buscador.
              </li>
              <li>Pega y revisa con «Ver en Google Maps» que el punto caiga en la puerta.</li>
            </ol>
            <p className="text-xs">
              El bot cobra cada domicilio desde este punto, así que un punto corrido cobra mal todos los pedidos de ese
              restaurante.
            </p>
          </div>
        </form>
      )}

      <section className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold">
          <Store size={16} className="text-clapi" /> Restaurantes
          {list && <span className="ml-auto text-xs font-normal text-ink-3">{list.length} registrados</span>}
        </div>
        {list === null ? (
          <p className="px-5 py-12 text-center text-sm text-ink-3">Cargando restaurantes…</p>
        ) : filtered.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-ink-3">
            {list.length === 0 ? "Todavía no hay restaurantes. Agrega el primero." : "Ninguno coincide con la búsqueda."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {filtered.map((r) => (
              <li key={r.id} className={`flex items-center gap-3 px-4 py-3 sm:px-5 ${r.active ? "" : "opacity-50"}`}>
                <span className="shrink-0"><PhotoButton name={r.name} photo={r.photo} className="h-12 w-12 bg-clapi/15 text-sm text-clapi-ink" onChange={(photo) => setPhoto(r.id, photo)} /></span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {r.name}
                    {!r.active && <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-3">Inactivo</span>}
                    {r.orderDeadline && (
                      <span className="flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
                        <Clock size={11} /> Hasta {formatClock(r.orderDeadline)}
                      </span>
                    )}
                    {!r.knownPickupLocation && (
                      <span className="rounded-md bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger">Sin ubicar</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-ink-2">
                    {r.phone ? `${formatPhone(r.phone)} · ` : ""}
                    {[r.knownPickupAddress, r.pickupDetail].filter(Boolean).join(", ") || "Sin dirección"}
                  </p>
                </div>
                {r.knownPickupLocation && (
                  <a
                    href={googleMapsLink(r.knownPickupLocation)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Ver ${r.name} en Google Maps`}
                    className="ease-ui flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-3 can-hover:hover:bg-sunken can-hover:hover:text-clapi"
                  >
                    <MapPin size={16} />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => open(r)}
                  aria-label={`Editar ${r.name}`}
                  className="ease-ui flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-3 can-hover:hover:bg-sunken can-hover:hover:text-clapi"
                >
                  <Pencil size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleting(r)}
                  aria-label={`Borrar ${r.name}`}
                  className="ease-ui flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-3 can-hover:hover:bg-danger-soft can-hover:hover:text-danger"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <ConfirmDialog
          title={`¿Borrar ${deleting.name}?`}
          points={[
            "Se borra del todo, no se puede deshacer. Si solo quieres pausarlo, desmárcalo como activo.",
            "Si escribe desde su número, el bot ya no lo reconoce.",
            "Sus viajes anteriores se conservan en los reportes.",
          ]}
          confirmLabel="Sí, borrar"
          onConfirm={() => remove(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
    </label>
  );
}
