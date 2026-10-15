// The System window (JD-30): plan usage running hot (5-hour 75% amber, weekly 92% red), a quiet
// container with no plan limits reported, and the first load still waiting. Voice latency (JD-48):
// on target in "system", nothing timed yet in "system-quiet", and missing the target on a slow brain.
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
  voiceLatency: { turns: 0, p50: null, p90: null, stages: [] },
};

/** The brain takes 1.7 s to its first words: p50 3.4 s and p90 4.6 s, both over the target. */
const slow: SystemResponse = {
  ...system,
  voiceLatency: {
    turns: 12,
    p50: 3420,
    p90: 4610,
    stages: [
      { stage: "endpoint", p50: 704 },
      { stage: "transcript", p50: 1180 },
      { stage: "sent", p50: 1186 },
      { stage: "accepted", p50: 1240 },
      { stage: "firstDelta", p50: 2950 },
      { stage: "firstSentence", p50: 3090 },
      { stage: "sayReady", p50: 3390 },
      { stage: "audioStart", p50: 3420 },
    ],
    last: {
      at: "2026-10-14T08:19:10Z",
      trigger: "ptt",
      speechMs: 2100,
      model: "claude-sonnet-5-5",
      stages: { endpoint: 704, transcript: 1210, sent: 1215, accepted: 1270, firstDelta: 3300 },
    },
  },
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
  one(
    "system-latency-slow",
    "System: voice latency over target (p50 3.4 s, p90 4.6 s), the brain's 1.7 s the biggest part; the last turn had no first word.",
    slow,
  ),
  one("system-loading", "System while the first GET /system is still on its way.", PENDING),
];

export default scenarios;
