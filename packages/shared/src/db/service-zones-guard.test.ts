import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Las zonas de servicio son de la central: ninguna migración ni despliegue
 * puede borrarlas ni cambiarlas (docs/DIRECCIONES-Y-ZONAS.md, «Zonas de
 * servicio»). Agregarles una columna sí se puede.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const MIGRATIONS = join(ROOT, "packages/shared/drizzle");
/** La migración que las crea: de ahí en adelante no se tocan. */
const CREATED_IN = 18;
const TABLES = "(service_zones|service_zone_versions)";

const DESTRUCTIVE = [
  new RegExp(`DROP\s+TABLE[^;]*"?${TABLES}"?`, "i"),
  new RegExp(`TRUNCATE[^;]*"?${TABLES}"?`, "i"),
  new RegExp(`DELETE\s+FROM\s+"?${TABLES}"?`, "i"),
  new RegExp(`UPDATE\s+"?${TABLES}"?\s+SET`, "i"),
  new RegExp(`ALTER\s+TABLE\s+"?${TABLES}"?[^;]*(DROP\s+COLUMN|ALTER\s+COLUMN|RENAME)`, "i"),
  new RegExp(`ALTER\s+TABLE\s+"?${TABLES}"?\s+RENAME`, "i"),
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("las zonas de servicio no se pierden", () => {
  it("ninguna migración posterior las borra ni las cambia", () => {
    const later = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > CREATED_IN);
    for (const file of later) {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");
      for (const pattern of DESTRUCTIVE) assert.doesNotMatch(sql, pattern, `${file} toca las zonas de servicio`);
    }
  });

  it("solo db/service-zones.ts las escribe (ni el seed ni los scripts)", () => {
    const sources = [join(ROOT, "packages/shared/src"), join(ROOT, "apps/bot/src"), join(ROOT, "apps/portal/src"), join(ROOT, "scripts")]
      .flatMap(files)
      .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !f.endsWith("service-zones.ts") && !f.endsWith("service-zones-guard.test.ts"));
    for (const file of sources) {
      const code = readFileSync(file, "utf8");
      assert.doesNotMatch(code, /\.(delete|update|insert)\((schema\.)?serviceZone(s|Versions)\b/, `${file} escribe las zonas de servicio`);
      assert.doesNotMatch(code, /(DELETE FROM|TRUNCATE|UPDATE)\s+"?service_zone/i, `${file} escribe las zonas de servicio`);
    }
  });
});
