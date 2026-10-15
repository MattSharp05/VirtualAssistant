import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageResponse } from "@jarvis/shared";
import type { DeskContext } from "../src/desk/routes/index.js";
import usageRoute, { usageResponse } from "../src/desk/routes/usage.js";
import type { Jarvis } from "../src/jarvis.js";
import type { PlanUsage } from "../src/usage.js";

const checkedAt = "2026-10-15T09:00:00.000Z";

test("usage: the tray's plan line gets rounded 5-hour and weekly percentages", async () => {
  const usage: PlanUsage = {
    available: true,
    windows: [
      { name: "five_hour", percent: 41.6 },
      { name: "seven_day", percent: 18.2, resetsAt: "2026-10-20T00:00:00Z" },
    ],
    checkedAt,
  };
  const ctx = { jarvis: { planUsage: async () => usage } as unknown as Jarvis } as DeskContext;
  const answer = (await usageRoute.handler({ ctx } as never)) as UsageResponse;
  assert.deepEqual(answer, { available: true, fiveHour: 42, weekly: 18, checkedAt });
});

test("usage: unavailable keeps the reason and leaves the percentages out", () => {
  const answer = usageResponse({ available: false, windows: [], reason: "This login doesn't report plan limits.", checkedAt });
  assert.deepEqual(answer, { available: false, reason: "This login doesn't report plan limits.", checkedAt });
  assert.equal(usageRoute.public, undefined, "needs a device key like every other route");
});
