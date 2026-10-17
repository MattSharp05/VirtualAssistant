// The Sessions window's states (JD-32): the grouped list with a session per group, and a fresh install.
// sessions-metrics-heavy (JD-54): mk has burned through its context (93%, red) and $1.3k, served
// by another model than the configured one; mk-80-builder is getting full (74%, amber).
import type { DeskSession, SessionDetail, SessionMetrics } from "@jarvis/shared";
import type { Scenario } from "../types";
import part from "../data/sessions";

const base = part.data ?? {};
const heavyMetrics: Record<string, Partial<SessionMetrics>> = {
  mk: {
    inputTokens: 412_330,
    outputTokens: 9_870_400,
    cacheReadTokens: 3_912_004_100,
    cacheWriteTokens: 31_220_800,
    totalTokens: 412_330 + 9_870_400 + 3_912_004_100 + 31_220_800,
    costUsd: 1284.52,
    contextUsedTokens: 931_200,
    contextPercent: 93.1,
    model: "claude-sonnet-5-5",
    configuredModel: "claude-opus-5-5",
  },
  "mk-80-builder": { contextUsedTokens: 742_000, contextPercent: 74.2, costUsd: 48.9 },
};
const heavyDetail: Record<string, Partial<SessionMetrics>> = {
  mk: { turns: 41, toolCalls: 2_410, activityPartial: true },
};

const heavy: Record<string, unknown> = { ...base };
heavy["/sessions"] = (base["/sessions"] as DeskSession[]).map((s) =>
  heavyMetrics[s.id] ? { ...s, metrics: { ...s.metrics!, ...heavyMetrics[s.id] } } : s,
);
for (const id of Object.keys(heavyMetrics)) {
  const d = base[`/sessions/${id}`] as SessionDetail;
  heavy[`/sessions/${id}`] = {
    ...d,
    session: {
      ...d.session,
      metrics: { ...d.session.metrics!, ...heavyMetrics[id], ...heavyDetail[id] },
    },
  } satisfies SessionDetail;
}

const scenarios: Scenario[] = [
  {
    name: "sessions",
    description: "Sessions window: mk blocked and trip ready for QA (needs you), two working, two idle.",
    data: base,
    events: [],
  },
  {
    name: "sessions-empty",
    description: "Sessions window with nothing tracked and no cloud sessions.",
    data: { "/sessions": [] },
    events: [],
  },
  {
    name: "sessions-metrics-heavy",
    description:
      "Sessions window: mk at 93% context (red) and $1.3k on another model than configured; mk-80-builder at 74% (amber).",
    data: heavy,
    events: [],
  },
];

export default scenarios;
