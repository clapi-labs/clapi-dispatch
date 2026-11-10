"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clock, useNow } from "@/lib/use-now";

/**
 * El mapa del simulador: motos, restaurantes, clientes y rutas, el ranking del
 * engine para cada pedido y los controles. Lee /api/simulador cada 2 s. No
 * calcula estados: la etiqueta de cada pedido es la de PHASE_LABEL que manda el
 * servidor, la misma de Viajes.
 */

type Point = { lat: number; lng: number };

type EngineMoto = {
  id: string;
  elegible: boolean;
  motivo: string | null;
  motivo_texto?: string | null;
  score?: number | null;
  f_tiempo?: number | null;
  f_ruta?: number | null;
  f_equidad?: number | null;
  t_a_min?: number | null;
  secuencia?: string | null;
  ruta_puntos?: [number, number][] | null;
};

type EngineResponse = {
  modo?: string;
  pesos?: number[];
  ganador?: string | null;
  explicacion?: string | null;
  despacho?: { faltan_min?: number; despachar_ts?: number };
  motos?: EngineMoto[];
};

type SimTrip = {
  id: number;
  code: string;
  status: string;
  phase: string;
  label: string;
  phaseSince: string | null;
  leftDelivery: boolean;
  restaurant: string;
  pickup: Point | null;
  delivery: Point | null;
  courierId: number | null;
  readyAt: string | null;
  evaluation: {
    status: string;
    reason: string | null;
    courierId: number | null;
    dispatchAt: string | null;
    faltanMin: number | null;
    response: EngineResponse | null;
  } | null;
};

type SimCourier = {
  id: number;
  name: string;
  status: "available" | "busy" | "paused" | "offline";
  lat: number | null;
  lng: number | null;
  locationUpdatedAt: string | null;
  deliveriesThisShift: number;
  openTrips: { id: number; code: string; label: string }[];
  controlledBy: string | null;
  parked: Point | null;
  route: Point[];
};

type State = {
  now: string;
  config: {
    speed: number;
    radiusKm: number;
    mode: string;
    sinSenalMin: number;
    gatePercent: number;
    returnPercent: number;
    noAnswerPercent: number;
    arrivalMeters: number;
  };
  home: Point;
  couriers: SimCourier[];
  testNumbers: { id: number; name: string; status: string; controls: string | null }[];
  restaurants: { id: number; name: string; location: Point }[];
  trips: SimTrip[];
};

type ClickMode = { kind: "order" } | { kind: "add" } | { kind: "move"; courierId: number } | null;

const EXCLUSION: Record<string, string> = {
  sin_senal: "sin GPS",
  fuera_radio: "fuera del radio",
  cliente_no_contesta: "esperando a un cliente",
  ocupada_sin_multipedido: "ocupada",
  capacidad: "cupo lleno",
  retraso: "retrasaría otro pedido",
};

const STATUS_COLOR: Record<SimCourier["status"], string> = {
  available: "#059669",
  busy: "#c2710c",
  paused: "#dc2626",
  offline: "#8b869c",
};

const ROUTE_COLORS = ["#532ce1", "#0b6bcb", "#c2710c", "#059669", "#dc2626", "#7c3aed", "#0891b2", "#be185d"];

const LEAFLET_SRC = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
// Huella del archivo (la misma que publica leafletjs.com para la 1.9.4): si el
// CDN sirve otra cosa, el navegador no lo ejecuta. Al cambiar de versión, se
// cambian las dos líneas.
const LEAFLET_INTEGRITY = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";

// Leaflet llega por CDN, sin tipos: lo mínimo que se usa.
type Leaflet = any;
declare global {
  interface Window {
    L?: Leaflet;
  }
}

function loadLeaflet(): Promise<Leaflet> {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${LEAFLET_SRC}"]`);
    const script =
      existing ?? Object.assign(document.createElement("script"), { src: LEAFLET_SRC, integrity: LEAFLET_INTEGRITY, crossOrigin: "anonymous", async: true });
    script.addEventListener("load", () => resolve(window.L));
    script.addEventListener("error", () => reject(new Error("No cargó Leaflet")));
    if (!existing) document.head.appendChild(script);
  });
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/simulador", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return data;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function SimulatorMap() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<number | null>(null);
  const [selectedCourier, setSelectedCourier] = useState<number | null>(null);
  const [mode, setMode] = useState<ClickMode>(null);
  const [chosenRestaurant, setOrderRestaurant] = useState<number | null>(null);
  const [orderReady, setOrderReady] = useState(5);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const router = useRouter();

  const mapEl = useRef<HTMLDivElement>(null);
  const L = useRef<Leaflet>(null);
  const map = useRef<Leaflet>(null);
  const layers = useRef<{ couriers: Map<number, Leaflet>; static: Leaflet; routes: Leaflet; focus: Leaflet } | null>(null);
  const modeRef = useRef<ClickMode>(null);
  const selectCourierRef = useRef<(id: number) => void>(() => {});
  const onMapClick = useRef<(p: Point) => void>(() => {});

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/simulador", { cache: "no-store" });
      if (res.status === 401) return router.replace("/login?next=/simulador");
      if (!res.ok) throw new Error(`Error ${res.status}`);
      setState(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [router]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const id = setInterval(() => void refresh(), 2000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh]);

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        await post(body);
        setError(null);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // El mapa, una sola vez.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((leaflet) => {
        if (cancelled || !mapEl.current || map.current) return;
        L.current = leaflet;
        const m = leaflet.map(mapEl.current, { zoomControl: true, doubleClickZoom: false, minZoom: 11, maxZoom: 19 }).setView([3.4372, -76.5225], 13);
        leaflet.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
        layers.current = {
          couriers: new Map(),
          static: leaflet.layerGroup().addTo(m),
          routes: leaflet.layerGroup().addTo(m),
          focus: leaflet.layerGroup().addTo(m),
        };
        m.on("click", (e: { latlng: { lat: number; lng: number } }) => onMapClick.current(e.latlng));
        map.current = m;
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const orderRestaurant = chosenRestaurant ?? state?.restaurants[0]?.id ?? null;

  // Lo que hace un toque en el mapa depende del modo y de lo elegido: el mapa
  // llama siempre a la última versión.
  useEffect(() => {
    onMapClick.current = (p: Point) => {
      const current = modeRef.current;
      if (!current) return;
      setMode(null);
      if (current.kind === "order") {
        if (orderRestaurant === null) return setError("Elige el restaurante");
        void run({ action: "order", restaurantId: orderRestaurant, lat: p.lat, lng: p.lng, readyInMinutes: orderReady });
      } else if (current.kind === "add") {
        void run({ action: "add", lat: p.lat, lng: p.lng });
      } else {
        void run({ action: "park", courierId: current.courierId, lat: p.lat, lng: p.lng });
      }
    };
    selectCourierRef.current = (id: number) => {
      setSelectedCourier(id);
      setSelectedTrip(null);
    };
  });

  const names = useMemo(() => new Map((state?.couriers ?? []).map((c) => [String(c.id), c.name])), [state]);
  const trip = state?.trips.find((t) => t.id === selectedTrip) ?? null;
  const signalMs = (state?.config.sinSenalMin ?? 2) * 60_000;

  // Dibuja lo que cambió.
  useEffect(() => {
    const leaflet = L.current;
    const m = map.current;
    const ls = layers.current;
    if (!leaflet || !m || !ls || !state) return;

    // Motos: se mueven en su lugar, sin redibujar.
    const seen = new Set<number>();
    for (const c of state.couriers) {
      if (c.lat == null || c.lng == null) continue;
      seen.add(c.id);
      const stale = !c.locationUpdatedAt || now - Date.parse(c.locationUpdatedAt) > signalMs;
      const color = stale ? STATUS_COLOR.offline : STATUS_COLOR[c.status];
      const ring = c.controlledBy ? "box-shadow:0 0 0 3px #532ce1;" : "";
      const html = `<div style="position:relative;width:30px;height:30px;border-radius:50%;background:${color};${ring}display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid #fff">🛵${
        c.openTrips.length ? `<span style="position:absolute;top:-6px;right:-6px;background:#0d0b14;color:#fff;border-radius:9px;font:600 11px/18px sans-serif;min-width:18px;text-align:center">${c.openTrips.length}</span>` : ""
      }</div>`;
      const icon = leaflet.divIcon({ html, className: "", iconSize: [30, 30], iconAnchor: [15, 15] });
      const label = `${esc(c.name)}${c.controlledBy ? ` · 📱 ${esc(c.controlledBy)}` : ""}${c.openTrips[0] ? ` · ${esc(c.openTrips[0].label)}` : ""}${stale ? " · sin señal" : ""}`;
      let marker = ls.couriers.get(c.id);
      if (!marker) {
        marker = leaflet.marker([c.lat, c.lng], { icon, zIndexOffset: 1000 }).addTo(m);
        marker.on("click", () => selectCourierRef.current(c.id));
        marker.bindTooltip(label, { direction: "top", offset: [0, -16] });
        ls.couriers.set(c.id, marker);
      } else {
        marker.setLatLng([c.lat, c.lng]);
        marker.setIcon(icon);
        marker.setTooltipContent(label);
      }
    }
    for (const [id, marker] of ls.couriers) {
      if (!seen.has(id)) {
        marker.remove();
        ls.couriers.delete(id);
      }
    }

    // Restaurantes y clientes.
    ls.static.clearLayers();
    for (const r of state.restaurants) {
      leaflet
        .marker([r.location.lat, r.location.lng], { icon: leaflet.divIcon({ html: `<div style="font-size:20px">🍔</div>`, className: "", iconSize: [24, 24], iconAnchor: [12, 12] }) })
        .bindTooltip(esc(r.name))
        .addTo(ls.static);
    }
    for (const t of state.trips) {
      if (!t.delivery || t.status === "delivered") continue;
      leaflet
        .marker([t.delivery.lat, t.delivery.lng], { icon: leaflet.divIcon({ html: `<div style="font-size:18px">🏠</div>`, className: "", iconSize: [22, 22], iconAnchor: [11, 11] }) })
        .bindTooltip(`${esc(t.code)} · ${esc(t.label)}`)
        .on("click", () => {
          setSelectedTrip(t.id);
          setSelectedCourier(null);
        })
        .addTo(ls.static);
    }

    // La ruta de cada moto.
    ls.routes.clearLayers();
    state.couriers.forEach((c, i) => {
      if (c.route.length < 2) return;
      leaflet
        .polyline(
          c.route.map((p) => [p.lat, p.lng]),
          { color: ROUTE_COLORS[i % ROUTE_COLORS.length], weight: c.id === selectedCourier ? 5 : 3, opacity: 0.75, dashArray: c.controlledBy ? undefined : "6 6" },
        )
        .addTo(ls.routes);
    });

    // El pedido elegido: radio y las tres mejores rutas del engine (verde la ganadora).
    ls.focus.clearLayers();
    if (trip?.pickup) {
      leaflet.circle([trip.pickup.lat, trip.pickup.lng], { radius: state.config.radiusKm * 1000, color: "#532ce1", weight: 1, fillOpacity: 0.04 }).addTo(ls.focus);
      const motos = trip.evaluation?.response?.motos?.filter((x) => x.elegible).slice(0, 3) ?? [];
      motos.forEach((x, i) => {
        if (!x.ruta_puntos?.length) return;
        leaflet.polyline(x.ruta_puntos, { color: i === 0 ? "#059669" : "#8b869c", weight: i === 0 ? 5 : 3, opacity: 0.8 }).addTo(ls.focus);
      });
    }
  }, [state, now, selectedCourier, trip, signalMs]);

  // Al llegar los datos por primera vez, centra en el simulador.
  const centered = useRef(false);
  useEffect(() => {
    if (!centered.current && state && map.current) {
      map.current.setView([state.home.lat, state.home.lng], 13);
      centered.current = true;
    }
  }, [state]);

  const pending = (state?.trips ?? []).filter((t) => t.status === "pending");
  const active = (state?.trips ?? []).filter((t) => t.status !== "pending");
  const courier = state?.couriers.find((c) => c.id === selectedCourier) ?? null;

  return (
    <div className="grid h-dvh grid-cols-1 bg-canvas text-ink md:grid-cols-[380px_1fr]">
      <style>{LEAFLET_CSS}</style>
      <aside className="flex min-h-0 flex-col overflow-y-auto border-r border-line bg-surface">
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h1 className="text-base font-semibold">🧪 Simulador</h1>
            <p className="text-xs text-ink-3">
              Engine en modo <strong>{state?.config.mode ?? "…"}</strong>
              {state && state.config.mode !== "auto" && <span className="text-danger"> · ponlo en auto para que asigne</span>}
            </p>
          </div>
          <Link href="/viajes" className="rounded-lg bg-clapi-soft px-3 py-1.5 text-sm font-semibold text-clapi-ink">
            Viajes
          </Link>
        </header>

        {error && <p className="mx-4 mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        {mode && (
          <p className="mx-4 mt-3 rounded-lg bg-gold-soft px-3 py-2 text-sm text-gold-ink">
            {mode.kind === "order" ? "Toca en el mapa dónde está el cliente." : mode.kind === "add" ? "Toca en el mapa dónde aparece la moto." : "Toca en el mapa a dónde mover la moto."}{" "}
            <button className="font-semibold underline" onClick={() => setMode(null)}>
              Cancelar
            </button>
          </p>
        )}

        <Section title="Controles">
          <label className="flex items-center justify-between gap-2 text-sm">
            Velocidad de las motos: <strong>{state?.config.speed ?? 1}×</strong>
            <input
              type="range"
              min={1}
              max={20}
              value={state?.config.speed ?? 1}
              onChange={(e) => void run({ action: "speed", value: Number(e.target.value) })}
              className="w-36"
            />
          </label>
          <p className="text-xs text-ink-3">Acelera el movimiento, no la cocina: para probar rápido, pide «listo en 5».</p>
          <NumberField label="Radio (km)" value={state?.config.radiusKm} step={0.5} onSave={(v) => run({ action: "radius", value: v })} />
          <div className="grid grid-cols-3 gap-2">
            <NumberField label="Portería %" value={state?.config.gatePercent} onSave={(v) => run({ action: "outcomes", gatePercent: v, returnPercent: state!.config.returnPercent, noAnswerPercent: state!.config.noAnswerPercent })} />
            <NumberField label="Vuelve %" value={state?.config.returnPercent} onSave={(v) => run({ action: "outcomes", gatePercent: state!.config.gatePercent, returnPercent: v, noAnswerPercent: state!.config.noAnswerPercent })} />
            <NumberField label="No contesta %" value={state?.config.noAnswerPercent} onSave={(v) => run({ action: "outcomes", gatePercent: state!.config.gatePercent, returnPercent: state!.config.returnPercent, noAnswerPercent: v })} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setMode({ kind: "add" })} disabled={busy}>
              + Moto
            </Button>
            {!confirmReset ? (
              <Button onClick={() => setConfirmReset(true)} disabled={busy} danger>
                Reiniciar
              </Button>
            ) : (
              <span className="flex items-center gap-2 text-sm">
                ¿Borrar lo simulado?
                <Button
                  danger
                  onClick={() => {
                    setConfirmReset(false);
                    void run({ action: "reset" });
                  }}
                >
                  Sí, reiniciar
                </Button>
                <Button onClick={() => setConfirmReset(false)}>No</Button>
              </span>
            )}
          </div>
        </Section>

        <Section title="Crear pedido sin WhatsApp">
          <select
            className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-sm"
            value={orderRestaurant ?? ""}
            onChange={(e) => setOrderRestaurant(Number(e.target.value))}
          >
            {(state?.restaurants ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <label className="flex items-center justify-between gap-2 text-sm">
            Listo en (min)
            <input type="number" min={0} max={180} value={orderReady} onChange={(e) => setOrderReady(Number(e.target.value))} className="w-20 rounded-lg border border-line bg-canvas px-2 py-1" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button primary disabled={busy || !state?.restaurants.length} onClick={() => setMode({ kind: "order" })}>
              Elegir cliente en el mapa
            </Button>
            <Button
              disabled={busy || !state?.restaurants.length}
              onClick={() => {
                const r = state?.restaurants.find((x) => x.id === orderRestaurant);
                if (!r) return;
                const p = randomNear(r.location, Math.min(3, state!.config.radiusKm));
                void run({ action: "order", restaurantId: r.id, lat: p.lat, lng: p.lng, readyInMinutes: orderReady });
              }}
            >
              Cliente al azar
            </Button>
          </div>
        </Section>

        <Section title="Números de prueba">
          {!state?.testNumbers.length && <p className="text-sm text-ink-3">Ninguno. Agrega una moto con número real en Flota y que le escriba al bot.</p>}
          {state?.testNumbers.map((n) => (
            <p key={n.id} className="flex justify-between text-sm">
              <span>📱 {n.name}</span>
              <span className="text-ink-3">
                {n.status !== "available" && n.status !== "busy" ? "desconectado" : n.controls ? `controla a ${n.controls}` : "libre"}
              </span>
            </p>
          ))}
        </Section>

        {courier && (
          <Section title={`Moto ${courier.name}`}>
            <p className="text-sm">
              {courier.openTrips.length ? courier.openTrips.map((t) => `${t.code}: ${t.label}`).join(" · ") : "Sin pedidos"}
            </p>
            <p className="text-xs text-ink-3">
              {courier.controlledBy ? `La controla 📱 ${courier.controlledBy}` : "Se maneja sola"} · {courier.deliveriesThisShift} viajes en el turno
              {courier.parked ? " · detenida a mano" : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setMode({ kind: "move", courierId: courier.id })}>Mover a mano</Button>
              {courier.parked && <Button onClick={() => void run({ action: "release", courierId: courier.id })}>Soltar</Button>}
              {courier.status === "offline" ? (
                <Button onClick={() => void run({ action: "connect", courierId: courier.id })}>Conectar</Button>
              ) : (
                <Button danger onClick={() => void run({ action: "disconnect", courierId: courier.id })}>
                  Desconectar
                </Button>
              )}
              <Button onClick={() => setSelectedCourier(null)}>Cerrar</Button>
            </div>
          </Section>
        )}

        {trip && <Ranking trip={trip} names={names} now={now} onClose={() => setSelectedTrip(null)} />}

        <Section title={`Por despachar (${pending.length})`}>
          {pending.map((t) => (
            <TripRow key={t.id} trip={t} now={now} selected={t.id === selectedTrip} onClick={() => setSelectedTrip(t.id)}>
              {t.evaluation?.dispatchAt && Date.parse(t.evaluation.dispatchAt) > now
                ? `se despacha en ${clock((Date.parse(t.evaluation.dispatchAt) - now) / 1000)}`
                : (t.evaluation?.reason ?? "esperando al engine")}
            </TripRow>
          ))}
        </Section>

        <Section title={`En curso (${active.length})`}>
          {active.map((t) => (
            <TripRow key={t.id} trip={t} now={now} selected={t.id === selectedTrip} onClick={() => setSelectedTrip(t.id)}>
              {t.courierId ? names.get(String(t.courierId)) ?? `moto ${t.courierId}` : ""}
            </TripRow>
          ))}
        </Section>

        <Section title={`Motos (${state?.couriers.length ?? 0})`}>
          {state?.couriers.map((c) => {
            const stale = !c.locationUpdatedAt || now - Date.parse(c.locationUpdatedAt) > signalMs;
            return (
              <button
                key={c.id}
                onClick={() => {
                  setSelectedCourier(c.id);
                  if (c.lat != null && c.lng != null) map.current?.panTo([c.lat, c.lng]);
                }}
                className={`flex w-full justify-between rounded-lg px-2 py-1 text-left text-sm ${c.id === selectedCourier ? "bg-clapi-soft" : "can-hover:hover:bg-sunken"}`}
              >
                <span>
                  <span style={{ color: STATUS_COLOR[c.status] }}>●</span> {c.name}
                  {c.controlledBy ? ` · 📱 ${c.controlledBy}` : ""}
                </span>
                <span className="text-ink-3">
                  {c.status === "offline" ? "desconectada" : stale ? "sin señal" : c.openTrips.length ? `${c.openTrips.length} · ${c.openTrips[0].label}` : "libre"}
                </span>
              </button>
            );
          })}
        </Section>
      </aside>
      <div className="relative min-h-[60vh]">
        <div ref={mapEl} className="absolute inset-0" style={{ cursor: mode ? "crosshair" : undefined }} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2 border-b border-line px-4 py-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

function Button({ children, onClick, disabled, primary, danger }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${
        primary ? "border-clapi bg-clapi text-white" : danger ? "border-line text-danger" : "border-line"
      }`}
    >
      {children}
    </button>
  );
}

function NumberField({ label, value, step = 1, onSave }: { label: string; value: number | undefined; step?: number; onSave: (v: number) => unknown }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="grid gap-1 text-xs text-ink-3">
      {label}
      <input
        type="number"
        step={step}
        value={draft ?? value ?? ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== "" && Number(draft) !== value) void onSave(Number(draft));
          setDraft(null);
        }}
        className="rounded-lg border border-line bg-canvas px-2 py-1 text-sm text-ink"
      />
    </label>
  );
}

function TripRow({ trip, now, selected, onClick, children }: { trip: SimTrip; now: number; selected: boolean; onClick: () => void; children: React.ReactNode }) {
  const since = trip.phaseSince ? clock((now - Date.parse(trip.phaseSince)) / 1000) : null;
  return (
    <button onClick={onClick} className={`grid w-full gap-0.5 rounded-lg px-2 py-1.5 text-left text-sm ${selected ? "bg-clapi-soft" : "can-hover:hover:bg-sunken"}`}>
      <span className="flex justify-between gap-2">
        <strong>
          {trip.code} · {trip.restaurant}
        </strong>
        <span className={trip.leftDelivery ? "text-danger" : "text-ink-2"}>
          {trip.label}
          {since ? ` · ${since}` : ""}
          {trip.leftDelivery ? " · se fue sin marcar la entrega" : ""}
        </span>
      </span>
      <span className="text-xs text-ink-3">{children}</span>
    </button>
  );
}

/** Lo que guardó el engine en `engine_evaluations.response`, tal cual. */
function Ranking({ trip, names, now, onClose }: { trip: SimTrip; names: Map<string, string>; now: number; onClose: () => void }) {
  const response = trip.evaluation?.response ?? null;
  const motos = response?.motos ?? [];
  const name = (id: string) => names.get(id) ?? `moto ${id}`;
  const dispatchAt = trip.evaluation?.dispatchAt ? Date.parse(trip.evaluation.dispatchAt) : null;
  return (
    <Section title={`Pedido ${trip.code} · ${trip.label}`}>
      {!response && <p className="text-sm text-ink-3">{trip.evaluation?.reason ?? "El engine todavía no lo ha evaluado."}</p>}
      {response && (
        <>
          {trip.status === "pending" && dispatchAt && dispatchAt > now && (
            <p className="text-sm">
              Se despacha en <strong>{clock((dispatchAt - now) / 1000)}</strong>
              {response.ganador ? ` · hoy ganaría ${name(response.ganador)}` : ""}
            </p>
          )}
          {response.explicacion && <p className="text-sm">{response.explicacion}</p>}
          <p className="text-xs text-ink-3">
            Horario {response.modo ?? "?"} · pesos tiempo/ruta/equidad {response.pesos?.map((p) => p.toFixed(2)).join(" / ")}
          </p>
          <table className="w-full text-xs">
            <thead className="text-ink-3">
              <tr>
                <th className="text-left font-medium">Moto</th>
                <th className="text-right font-medium">Puntaje</th>
                <th className="text-right font-medium">Tiempo</th>
                <th className="text-right font-medium">Ruta</th>
                <th className="text-right font-medium">Equidad</th>
              </tr>
            </thead>
            <tbody>
              {motos.map((m) => (
                <tr key={m.id} className={m.id === response.ganador ? "font-semibold text-ok" : m.elegible ? "" : "text-ink-3"}>
                  <td>{name(m.id)}</td>
                  {m.elegible ? (
                    <>
                      <td className="text-right tabular-nums">{m.score?.toFixed(1)}</td>
                      <td className="text-right tabular-nums">{m.f_tiempo?.toFixed(1)}</td>
                      <td className="text-right tabular-nums">{m.f_ruta?.toFixed(1)}</td>
                      <td className="text-right tabular-nums">{m.f_equidad?.toFixed(1)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="text-right">
                      Excluida: {m.motivo_texto ?? (m.motivo ? (EXCLUSION[m.motivo] ?? m.motivo) : "")}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div>
        <Button onClick={onClose}>Cerrar</Button>
      </div>
    </Section>
  );
}

function randomNear(center: Point, km: number): Point {
  const r = km * Math.sqrt(Math.random());
  const a = Math.random() * 2 * Math.PI;
  return { lat: center.lat + (r / 111.32) * Math.cos(a), lng: center.lng + (r / (111.32 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(a) };
}

/** Lo mínimo de la hoja de estilos de Leaflet, como en el mapa de zonas. */
const LEAFLET_CSS = `
.leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas,.leaflet-zoom-box,.leaflet-image-layer,.leaflet-layer{position:absolute;left:0;top:0}
.leaflet-container{overflow:hidden;outline:0;-webkit-tap-highlight-color:transparent;background:#f1eff7}
.leaflet-container.leaflet-touch-zoom{touch-action:pan-x pan-y}.leaflet-container.leaflet-touch-drag{touch-action:none}
.leaflet-pane{z-index:400}.leaflet-overlay-pane{z-index:400}.leaflet-marker-pane{z-index:600}.leaflet-tooltip-pane{z-index:650}.leaflet-popup-pane{z-index:700}
.leaflet-map-pane canvas{z-index:100}.leaflet-map-pane svg{z-index:200}
.leaflet-zoom-animated{transform-origin:0 0}.leaflet-zoom-anim .leaflet-zoom-animated{transition:transform .25s cubic-bezier(0,0,.25,1)}
.leaflet-interactive{cursor:pointer}.leaflet-grab{cursor:grab}.leaflet-dragging .leaflet-grab{cursor:grabbing}
.leaflet-marker-icon{display:block}.leaflet-tile{visibility:hidden}.leaflet-tile-loaded{visibility:inherit}
.leaflet-container img.leaflet-tile{max-width:none!important;max-height:none!important;user-select:none}
.leaflet-control-attribution{margin:0;padding:0 5px;font-size:11px;background:rgba(255,255,255,.8);color:#333}
.leaflet-control-container .leaflet-top,.leaflet-control-container .leaflet-bottom{position:absolute;z-index:800;pointer-events:none}
.leaflet-top{top:0}.leaflet-left{left:0}.leaflet-right{right:0}.leaflet-bottom{bottom:0}
.leaflet-control{position:relative;z-index:800;pointer-events:auto;float:left;clear:both;margin:12px 0 0 12px}
.leaflet-bar{border:1px solid #e9e6f1;border-radius:6px;background:#fff;overflow:hidden}
.leaflet-bar a{display:block;width:32px;height:32px;line-height:32px;text-align:center;text-decoration:none;color:#0d0b14;font-size:18px;font-weight:600}
.leaflet-bar a+a{border-top:1px solid #e9e6f1}
.leaflet-tooltip{position:absolute;padding:2px 6px;background:#fff;color:#0d0b14;border:1px solid #e9e6f1;border-radius:4px;white-space:nowrap;font-size:12px;pointer-events:none}
`;
