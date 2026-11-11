import { readFileSync } from "node:fs";

import { createServiceZone, listServiceZones, validateServiceZone } from "./service-zones";

/**
 * Carga zonas de servicio desde la copia que descarga el portal («Descargar
 * copia» en /zonas, un GeoJSON). Sirve para pasar las zonas de staging a
 * producción, o para recuperar una copia.
 *
 *   npm run zonas:importar -- zonas-de-servicio-2026-11-10.geojson
 *   cat zonas.geojson | npm run zonas:importar -- -
 *
 * Solo agrega: nunca borra ni cambia una zona que ya exista. Una zona con el
 * mismo nombre y el mismo borde que una que ya está se salta, así que se puede
 * correr dos veces sin duplicar nada.
 */

type Feature = {
  properties?: { name?: unknown; barrioCode?: unknown };
  geometry?: { type?: string; coordinates?: number[][][] };
};

/** Nombre y borde, con las coordenadas a 6 decimales como las guarda el portal. */
const key = (name: string, ring: { lat: number; lng: number }[]) => `${name}|${ring.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(";")}`;

async function main() {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("Uso: npm run zonas:importar -- <archivo.geojson>   (o - para leer de la entrada)");
  const data = JSON.parse(readFileSync(path === "-" ? 0 : path, "utf8")) as { features?: Feature[] };
  if (!Array.isArray(data.features)) throw new Error("El archivo no es la copia de zonas del portal (falta «features»).");

  const existing = new Set((await listServiceZones()).map((z) => key(z.name, z.ring)));
  let added = 0;
  let skipped = 0;
  for (const [i, f] of data.features.entries()) {
    const outer = f.geometry?.type === "Polygon" ? f.geometry.coordinates?.[0] : undefined;
    // GeoJSON repite el primer punto al final y va en [lng, lat].
    const ring = (outer ?? []).slice(0, -1).map(([lng, lat]) => ({ lat, lng }));
    const checked = validateServiceZone({ name: f.properties?.name, barrioCode: f.properties?.barrioCode, ring });
    if ("error" in checked) throw new Error(`La zona ${i + 1} no sirve: ${checked.error}. No se cargó nada después de ella.`);
    if (existing.has(key(checked.zone.name, checked.zone.ring))) {
      skipped++;
      continue;
    }
    await createServiceZone(checked.zone);
    existing.add(key(checked.zone.name, checked.zone.ring));
    added++;
  }
  console.log(`${added} zonas agregadas, ${skipped} ya estaban.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
