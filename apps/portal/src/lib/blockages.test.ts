import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { criticalBlockedIds, hasNewCritical } from "./blockages";
import type { Trip } from "./types";

const NOW = Date.parse("2026-11-18T15:00:00Z");
const trip = (id: number, kind: Trip["blockageKind"], minutesAgo: number) =>
  ({ id, blockageKind: kind, blockageAt: new Date(NOW - minutesAgo * 60_000).toISOString() }) as Trip;

describe("criticalBlockedIds", () => {
  it("cuenta solo los críticos que ya empezaron", () => {
    const ids = criticalBlockedIds(
      [trip(1, "pickup_late", 1), trip(2, "delivery_late", 5), trip(3, "return_late", 0), trip(4, "customer_no_answer", 9), trip(5, "pickup_late", -3), trip(6, null, 1)],
      NOW,
    );
    assert.deepEqual([...ids].sort(), [1, 2, 3]);
  });
});

describe("hasNewCritical", () => {
  it("la primera carga no suena", () => {
    assert.equal(hasNewCritical(new Set([1]), null), false);
  });

  it("suena con un bloqueo nuevo aunque la cuenta no suba (sale uno y entra otro)", () => {
    assert.equal(hasNewCritical(new Set([2]), new Set([1])), true);
  });

  it("no suena si no hay nada nuevo, ni cuando uno se resuelve", () => {
    assert.equal(hasNewCritical(new Set([1]), new Set([1])), false);
    assert.equal(hasNewCritical(new Set(), new Set([1])), false);
  });
});
