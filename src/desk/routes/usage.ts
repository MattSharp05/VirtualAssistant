// The plan line in the Desk's tray menu (JD-26):
//   GET /api/desk/usage → { available, fiveHour?, weekly?, reason?, checkedAt }
import type { UsageResponse } from "@jarvis/shared";
import type { PlanUsage } from "../../usage.js";
import type { DeskRoute } from "./index.js";

export function usageResponse(usage: PlanUsage): UsageResponse {
  const percent = (name: string) => usage.windows.find((w) => w.name === name)?.percent;
  const fiveHour = percent("five_hour");
  const weekly = percent("seven_day");
  return {
    available: usage.available,
    ...(fiveHour === undefined ? {} : { fiveHour: Math.round(fiveHour) }),
    ...(weekly === undefined ? {} : { weekly: Math.round(weekly) }),
    ...(usage.reason ? { reason: usage.reason } : {}),
    checkedAt: usage.checkedAt,
  };
}

const route: DeskRoute = {
  method: "GET",
  path: "/usage",
  handler: async ({ ctx }) => usageResponse(await ctx.jarvis.planUsage()),
};

export default route;
