"use client";

import { hasSignal, signalState } from "@dispatch/shared/domain/gps";
import { useEffect, useRef, useState } from "react";

import { elapsedLabel, timeOfDay } from "@/lib/format";
import { LEAFLET_CSS, loadLeaflet, OSM_TILES, type Leaflet } from "@/lib/leaflet";
import type { Courier } from "@/lib/types";

/**
 * Dónde están los domiciliarios (issues #42 y #53). Funciona igual en
 * producción y en staging: no depende del simulador.
 * - En turno: color de su estado si está en vivo o quieto; gris punteado si perdió la señal.
 * - Fuera de turno pero con GPS en vivo/quieto: también se muestra en gris con borde verde para distinguirlos.
 */

const COLOR: Record<Courier["status"], string> = {
  available: "#059669",
  busy: "#c2710c",
  paused: "#dc2626",
  offline: "#8b869c",
};
const LOST = "#8b869c";
const CALI: [number, number] = [3.4372, -76.5225];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function FleetMap({ couriers, now }: { couriers: Courier[]; now: number }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const L = useRef<Leaflet>(null);
  const map = useRef<Leaflet>(null);
  const markers = useRef(new Map<number, Leaflet>());
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // El mapa, una sola vez.
  useEffect(() => {
    let cancelled = false;
    const placed = markers.current;
    loadLeaflet()
      .then((leaflet) => {
        if (cancelled || !mapEl.current || map.current) return;
        L.current = leaflet;
        map.current = leaflet.map(mapEl.current, { zoomControl: true, minZoom: 10, maxZoom: 19 }).setView(CALI, 13);
        leaflet.tileLayer(OSM_TILES, { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map.current);
        setReady(true);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      placed.clear();
    };
  }, []);

  const shown = couriers.filter((c) => c.lat != null && c.lng != null && (c.status !== "offline" || hasSignal(c, now)));

  // Las motos se mueven en su lugar, sin redibujar el mapa.
  useEffect(() => {
    const leaflet = L.current;
    const m = map.current;
    if (!ready || !leaflet || !m) return;
    const seen = new Set<number>();
    for (const c of shown) {
      seen.add(c.id);
      const state = signalState(c, now);
      const live = state === "live" || state === "still";
      const off = c.status === "offline";
      const color = off ? COLOR.offline : live ? COLOR[c.status] : LOST;
      const border = off ? "2px solid #059669" : live ? "2px solid #fff" : "2px dashed #fff";
      const html = `<div style="width:30px;height:30px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:16px;border:${border};${
        live ? (off ? "opacity:.9;" : "") : "opacity:.75;"
      }box-shadow:0 1px 3px rgba(0,0,0,.3)">🛵</div>`;
      const icon = leaflet.divIcon({ html, className: "", iconSize: [30, 30], iconAnchor: [15, 15] });
      const since = c.locationUpdatedAt ? new Date(c.locationUpdatedAt) : null;
      const gpsText =
        state === "live"
          ? "en vivo"
          : state === "still"
            ? "quieto"
            : `sin señal${since ? ` desde ${timeOfDay(since)} (hace ${elapsedLabel(since, new Date(now))})` : ""}`;
      const label = `${esc(c.name)}${c.simulator?.role === "simulated" ? " · 🧪 simulada" : ""}${off ? " · fuera de turno" : ""} · ${gpsText}`;
      let marker = markers.current.get(c.id);
      const z = off ? 500 : live ? 1000 : 0;
      if (!marker) {
        marker = leaflet.marker([c.lat, c.lng], { icon, zIndexOffset: z }).addTo(m);
        marker.bindTooltip(label, { direction: "top", offset: [0, -16] });
        markers.current.set(c.id, marker);
      } else {
        marker.setLatLng([c.lat, c.lng]);
        marker.setIcon(icon);
        marker.setTooltipContent(label);
        marker.setZIndexOffset(z);
      }
    }
    for (const [id, marker] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    // La primera vez, el mapa encuadra a todas las motos; después no se mueve solo.
    if (!fitted.current && shown.length) {
      fitted.current = true;
      if (shown.length === 1) m.setView([shown[0].lat, shown[0].lng], 15);
      else m.fitBounds(shown.map((c) => [c.lat, c.lng]), { padding: [40, 40], maxZoom: 16 });
    }
  });

  return (
    <div className="card relative h-[70vh] min-h-[360px] overflow-hidden">
      <style>{LEAFLET_CSS}</style>
      <div ref={mapEl} className="absolute inset-0" />
      {error && <p className="absolute inset-x-0 top-3 mx-auto w-fit rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">{error}</p>}
      {ready && shown.length === 0 && (
        <p className="pointer-events-none absolute inset-x-0 top-3 z-[1000] mx-auto w-fit rounded-lg bg-surface px-3 py-1.5 text-sm text-ink-3 shadow">
          Ninguna moto en turno ni con GPS en vivo.
        </p>
      )}
    </div>
  );
}
