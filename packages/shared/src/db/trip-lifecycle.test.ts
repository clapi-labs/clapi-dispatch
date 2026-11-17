import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PgDialect } from "drizzle-orm/pg-core";

import * as db from "./index";
import { openTripCondition } from "./trip-lifecycle";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", ".next", "dist", "graphify-out", ".git"].includes(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|py)$/.test(name) ? [path] : [];
  });
}

describe("ciclo de vida del viaje", () => {
  it("exporta las mutaciones que usan el bot, el engine y el portal", () => {
    for (const name of ["assignTripTo", "saveCourierRoute", "returnTripToDispatch", "returnUnpickedTrips", "closeUndeliveredTrip", "deliverTrip", "openTripCondition"]) {
      assert.equal(typeof (db as Record<string, unknown>)[name], "function", name);
    }
  });

  it("lo que el motorizado lleva encima es asignado o en ruta", () => {
    const { params } = new PgDialect().sqlToQuery(openTripCondition());
    assert.deepEqual(params, ["assigned", "en_route"]);
  });

  it("la cola legada ya no existe", () => {
    const thisFile = fileURLToPath(import.meta.url);
    for (const file of sourceFiles(ROOT)) {
      if (file === thisFile) continue;
      const text = readFileSync(file, "utf8");
      assert.ok(!/assignPendingTrips|assignNextCourier|dispatch-queue/.test(text), `${file} menciona la cola legada`);
    }
  });
});
