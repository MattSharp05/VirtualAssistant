// The System window (JD-30): plan usage running hot (5-hour 75% amber, weekly 92% red), a quiet
// container with no plan limits reported, and the first load still waiting.
import type { SystemResponse } from "@jarvis/shared";
import { PENDING } from "../bridge";
import { system } from "../data/system";
import type { Scenario } from "../types";

const one = (name: string, description: string, response: SystemResponse | typeof PENDING): Scenario => ({
  name,
  description,
  data: { "/system": response },
  events: [],
});

const hot: SystemResponse = {
  ...system,
  plan: { ...system.plan, fiveHour: 75, weekly: 92 },
  fires: { ...system.fires, used: 24 },
  container: { ...system.container, cpu: 12.4, claudeProcs: 3 },
};

const quiet: SystemResponse = {
  ...system,
  plan: { available: false, fiveHour: null, weekly: null, reason: "This login doesn't report plan limits." },
  fires: { configured: false, used: 0, limit: 30 },
  container: {
    ...system.container,
    memUsed: 184 * 2 ** 20,
    memLimit: null,
    memPeak: 190 * 2 ** 20,
    cpu: null,
    claudeProcs: 0,
    uptimeSeconds: 40,
    memHistory: [],
  },
  brain: {
    chatToday: { replies: 0, tokens: 0, turns: 0, ms: 0 },
    workerToday: { replies: 0, tokens: 0, turns: 0, ms: 0 },
  },
  devices: [],
};

const scenarios: Scenario[] = [
  one(
    "system",
    "System: plan 5-hour 75% (amber) and weekly 92% (red), 24/30 routine fires, memory sparkline, worker vs chat today.",
    hot,
  ),
  one(
    "system-quiet",
    "System just after a restart: no plan limits reported, no routine, no memory limit or history, nothing used today.",
    quiet,
  ),
  one("system-loading", "System while the first GET /system is still on its way.", PENDING),
];

export default scenarios;
