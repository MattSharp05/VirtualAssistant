// The System window (JD-30), typed as the server's SystemResponse: a calm demo day (the menu bar
// mockup's "5-hour 42% · weekly 18%"), an hour of memory history, two paired Macs, and voice turns
// that meet the PRD's latency target (JD-48).
import type { SystemResponse, VoiceLatencySummary } from "@jarvis/shared";
import type { ScenarioPart } from "../types";

const MB = 2 ** 20;
export const SYSTEM_CHECKED_AT = "2026-10-14T08:20:00Z";
const checked = Date.parse(SYSTEM_CHECKED_AT);
const minutes = (n: number) => new Date(checked + n * 60_000).toISOString();

/** Memory every 10 s for the last hour: a slow climb with the bumps of a few brain replies. */
export function memoryHistory(fromMb: number, toMb: number): SystemResponse["container"]["memHistory"] {
  return Array.from({ length: 360 }, (_, i) => {
    const trend = fromMb + ((toMb - fromMb) * i) / 359;
    const bump = 14 * Math.max(0, Math.sin(i / 9)) ** 6 + 4 * Math.sin(i / 23);
    return {
      at: new Date(checked - (359 - i) * 10_000).toISOString(),
      memUsed: Math.round((trend + bump) * MB),
    };
  });
}

/** 20 voice turns: first word 2.2 s median, 3.2 s p90; the brain's first words the biggest part. */
export const voiceLatency: VoiceLatencySummary = {
  turns: 20,
  p50: 2240,
  p90: 3180,
  stages: [
    { stage: "endpoint", p50: 704 },
    { stage: "transcript", p50: 1060 },
    { stage: "sent", p50: 1066 },
    { stage: "accepted", p50: 1110 },
    { stage: "firstDelta", p50: 1830 },
    { stage: "firstSentence", p50: 1905 },
    { stage: "sayReady", p50: 2215 },
    { stage: "audioStart", p50: 2240 },
  ],
  last: {
    at: minutes(-2),
    trigger: "wake",
    speechMs: 1680,
    model: "claude-sonnet-5-5",
    stages: {
      endpoint: 704,
      transcript: 1032,
      sent: 1038,
      accepted: 1090,
      firstDelta: 1790,
      firstSentence: 1860,
      sayReady: 2170,
      audioStart: 2190,
    },
  },
};

export const system: SystemResponse = {
  checkedAt: SYSTEM_CHECKED_AT,
  plan: {
    available: true,
    fiveHour: 42,
    weekly: 18,
    resetsAt: minutes(130),
    weeklyResetsAt: minutes(3 * 24 * 60 + 15 * 60 + 40),
  },
  fires: { configured: true, used: 6, limit: 30, nextFreeAt: minutes(34) },
  container: {
    memUsed: 412 * MB,
    memLimit: 1024 * MB,
    memPeak: 486 * MB,
    cpu: 3.2,
    claudeProcs: 1,
    uptimeSeconds: 2 * 86400 + 5 * 3600 + 12 * 60,
    memHistory: memoryHistory(368, 412),
  },
  brain: {
    chatToday: { replies: 14, tokens: 412_800, turns: 31, ms: 96_000 },
    workerToday: { replies: 9, tokens: 188_400, turns: 22, ms: 214_000 },
  },
  devices: [
    { id: "d1", name: "Matthew's MacBook Pro", createdAt: "2026-10-01T10:00:00Z", lastSeen: minutes(-1) },
    { id: "d2", name: "Studio Mac", createdAt: "2026-10-03T10:00:00Z", lastSeen: minutes(-26 * 60) },
  ],
  voiceLatency,
};

const part: ScenarioPart = { data: { "/system": system } };
export default part;
