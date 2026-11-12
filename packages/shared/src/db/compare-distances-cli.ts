import { haversineKm } from "../domain/dispatch/haversine";
import { ROUTE_FACTOR, straightRouteKm } from "../domain/road-distance";
import { getFareRanges, priceForDistance } from "./fares";
import { db, schema } from "./client";
import { listServiceZones } from "./service-zones";

/**
 * Cuánto cambia la distancia por calle (OSRM) frente a la de hoy (línea recta
 * × 1,3), de cada restaurante con ubicación hacia el centro de cada zona de
 * servicio. Sirve para ajustar la tabla de precios antes de encender
 * `routing_config.porCalle`. Solo imprime números agregados: ninguna
 * coordenada, ningún nombre.
 *
 *   OSRM_URL=http://localhost:5000 npm run calles:comparar
 *   # en el servidor: deploy/compare-distances.sh
 *
 * No cambia nada en la base.
 */

type Point = { lat: number; lng: number };

/** El centro de una zona: el promedio de sus esquinas (basta para medir). */
const center = (ring: Point[]): Point => ({
  lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length,
  lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length,
});

async function streetKm(base: string, from: Point, to: Point): Promise<number | null> {
  const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = (await response.json().catch(() => null)) as { code?: string; routes?: { distance: number }[]; waypoints?: { distance: number }[] } | null;
  if (body?.code !== "Ok" || !body.routes?.length) return null;
  if ((body.waypoints ?? []).some((w) => w.distance > 500)) return null; // fuera del mapa
  return body.routes[0].distance / 1000;
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const n1 = (x: number) => x.toLocaleString("es-CO", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const n2 = (x: number) => x.toLocaleString("es-CO", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const pct = (part: number, total: number) => `${Math.round((part / total) * 100)} %`;

async function main() {
  const base = (process.env.OSRM_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("Falta OSRM_URL (p. ej. http://localhost:5000).");

  const [restaurants, zones, ranges] = await Promise.all([db.select().from(schema.restaurants), listServiceZones(), getFareRanges()]);
  const origins = restaurants.map((r) => r.knownPickupLocation).filter((p): p is Point => Boolean(p));
  const targets = zones.map((z) => center(z.ring));
  if (!origins.length || !targets.length) throw new Error(`Hace falta al menos un restaurante con ubicación (${origins.length}) y una zona (${targets.length}).`);

  const rows: { straight: number; today: number; street: number; ratio: number }[] = [];
  let failed = 0;
  let measured = 0;
  const started = Date.now();
  // De a pocas a la vez: es el OSRM del servidor, no hay que apurarlo.
  const pairs = origins.flatMap((o) => targets.map((t) => [o, t] as const)).filter(([o, t]) => haversineKm(o, t) >= 0.3);
  for (let i = 0; i < pairs.length; i += 8) {
    const batch = pairs.slice(i, i + 8);
    const results = await Promise.all(batch.map(([o, t]) => streetKm(base, o, t).catch(() => null)));
    batch.forEach(([o, t], k) => {
      const street = results[k];
      measured++;
      if (street === null) return void failed++;
      const straight = haversineKm(o, t);
      rows.push({ straight, today: straightRouteKm(o, t), street, ratio: street / straight });
    });
  }
  const msPerRoute = (Date.now() - started) / Math.max(1, measured);

  const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
  const diffs = rows.map((r) => r.street - r.today).sort((a, b) => a - b);
  const short05 = diffs.filter((d) => d > 0.5).length;
  const long05 = diffs.filter((d) => d < -0.5).length;

  const lines = [
    `Distancia por calle (OSRM) frente a la de hoy (línea recta × ${n1(ROUTE_FACTOR)})`,
    `Trayectos: ${rows.length} (${origins.length} restaurantes × ${targets.length} zonas; ${failed} sin ruta, fuera del mapa o a menos de 300 m)`,
    "",
    "Calle ÷ línea recta",
    `  mediana ${n2(quantile(ratios, 0.5))} · p10 ${n2(quantile(ratios, 0.1))} · p90 ${n2(quantile(ratios, 0.9))} · mín ${n2(ratios[0])} · máx ${n2(ratios.at(-1)!)}`,
    "",
    "Calle − hoy (km)",
    `  mediana ${n1(quantile(diffs, 0.5))} · p10 ${n1(quantile(diffs, 0.1))} · p90 ${n1(quantile(diffs, 0.9))} · máx ${n1(diffs.at(-1)!)}`,
    `  hoy se queda corto por más de 0,5 km: ${short05} (${pct(short05, rows.length)}) · se pasa por más de 0,5 km: ${long05} (${pct(long05, rows.length)})`,
  ];

  if (ranges.length) {
    const priced = rows.map((r) => ({ today: priceForDistance(r.today, ranges)!, street: priceForDistance(Math.round(r.street * 10) / 10, ranges)! }));
    const up = priced.filter((p) => p.street > p.today);
    const down = priced.filter((p) => p.street < p.today);
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);
    lines.push(
      "",
      "Con la tabla de Tarifas de hoy (para dimensionar; la tabla nueva la define el cliente)",
      `  sube de precio: ${up.length} (${pct(up.length, rows.length)}), en promedio $ ${avg(up.map((p) => p.street - p.today)).toLocaleString("es-CO")}`,
      `  baja de precio: ${down.length} (${pct(down.length, rows.length)}) · igual: ${rows.length - up.length - down.length}`,
      `  precio promedio: hoy $ ${avg(priced.map((p) => p.today)).toLocaleString("es-CO")} · por calle $ ${avg(priced.map((p) => p.street)).toLocaleString("es-CO")}`,
    );
  }
  lines.push("", `Tiempo por ruta: ${Math.round(msPerRoute)} ms (de a 8 en paralelo)`);
  console.log(lines.join("\n"));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
