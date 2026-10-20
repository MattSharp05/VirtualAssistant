// Cloud sessions JARVIS tracks (JD-32, mockup 4), typed as the server's Desk API so the preview and
// the real thing match. Times are relative to when the preview loads (e2e fixes the clock).
import type {
  DeskSession,
  SessionDetail,
  SessionMetrics,
  SessionReport,
  SessionSendResponse,
} from "@jarvis/shared";
import type { ScenarioPart } from "../types";

const loaded = Date.now();
const ago = (min: number) => new Date(loaded - min * 60_000).toISOString();
const url = (id: string) => `https://claude.ai/code/${id}`;

export const sessions: DeskSession[] = [
  {
    id: "mk",
    name: "mk",
    sessionId: "session_01MK",
    title: "Mario Kart orchestrator",
    status: "running",
    lastActivity: ago(12),
    group: "needs-you",
    latestReport: "⛔ MK-81 blocked: drift boost vs the PRD speed cap",
    latestKind: "blocked",
    url: url("session_01MK"),
  },
  {
    id: "trip",
    name: "trip",
    sessionId: "session_01TR",
    title: "Trip planner orchestrator",
    status: "idle",
    lastActivity: ago(40),
    group: "needs-you",
    latestReport: "Batch 3 done · 6 tickets ready for QA",
    latestKind: "finished",
    url: url("session_01TR"),
  },
  {
    id: "mk-80-builder",
    name: "mk-80-builder",
    sessionId: "session_01MK80",
    title: "MK-80 track hazards",
    status: "running",
    lastActivity: ago(1),
    group: "working",
    latestReport: "MK-80 · track hazards · running tests",
    latestKind: "info",
    url: url("session_01MK80"),
  },
  {
    id: "session_01SM",
    sessionId: "session_01SM",
    title: "ShapeMint: refactor export pipeline",
    status: "running",
    lastActivity: ago(6),
    group: "working",
    url: url("session_01SM"),
  },
  {
    id: "virtual-assistant",
    name: "virtual-assistant",
    sessionId: "session_01VA",
    title: "JARVIS brain + connectors",
    status: "idle",
    lastActivity: ago(130),
    group: "idle",
    latestReport: "JD-17 merged ✅",
    latestKind: "info",
    url: url("session_01VA"),
  },
  {
    id: "notes-cleanup",
    name: "notes-cleanup",
    sessionId: "session_01NC",
    title: "Tidy Notion workspace",
    status: "idle",
    lastActivity: ago(26 * 60),
    group: "idle",
    url: url("session_01NC"),
  },
];

// What each session has used (JD-53), shaped like the server's SessionMetrics: the list rows carry
// the usage part; the detail adds turns, tool calls, PRs and active time. notes-cleanup is an older
// session whose detail has no usage, so its numbers are unknown (absent), not 0.
const min = 60_000;
const usage = (
  createdMin: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  costUsd: number,
  contextUsed: number,
  rest: Partial<SessionMetrics> = {},
): SessionMetrics => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  costUsd,
  contextUsedTokens: contextUsed,
  contextMaxTokens: 1_000_000,
  contextPercent: Math.round(contextUsed / 1000) / 10,
  model: "claude-opus-5-5",
  statusBucket: "working",
  createdAt: ago(createdMin),
  updatedAt: ago(1),
  wallMs: createdMin * min,
  finished: false,
  checkedAt: ago(0),
  ...rest,
});

const rowMetrics: Record<string, SessionMetrics> = {
  mk: usage(26 * 60, 98_498, 2_654_189, 820_538_750, 8_315_652, 269.76, 270_674, {
    statusBucket: "blocked",
    tags: ["orchestrator", "mario-kart"],
    repo: "MattSharp05/MarioKart",
    updatedAt: ago(12),
  }),
  trip: usage(9 * 60, 41_220, 812_400, 214_880_100, 2_904_330, 71.12, 148_900, {
    statusBucket: "review_ready",
    tags: ["orchestrator", "project:Trip planner"],
    updatedAt: ago(40),
  }),
  "mk-80-builder": usage(47, 6_812, 96_455, 18_402_300, 512_090, 6.38, 512_400, {
    model: "claude-sonnet-5-5",
    parentId: "session_01MK",
    tags: ["builder"],
    repo: "MattSharp05/MarioKart",
  }),
  session_01SM: usage(95, 12_030, 140_210, 31_550_000, 880_400, 11.04, 61_200, {
    repo: "MattSharp05/ShapeMint",
  }),
  "virtual-assistant": usage(5 * 60, 30_100, 402_900, 96_310_000, 1_204_000, 33.9, 880_100, {
    tags: ["project:JARVIS Desk"],
    repo: "MattSharp05/VirtualAssistant",
    statusBucket: "completed",
    updatedAt: ago(130),
    wallMs: (5 * 60 - 130) * min,
    finished: true,
  }),
  "notes-cleanup": {
    statusBucket: "completed",
    createdAt: ago(27 * 60),
    updatedAt: ago(26 * 60),
    wallMs: 60 * min,
    finished: true,
    checkedAt: ago(0),
  },
};

const activityMetrics: Record<string, Partial<SessionMetrics>> = {
  mk: {
    turns: 14,
    toolCalls: 612,
    prs: [1, 2, 3, 4].map((n) => `https://github.com/MattSharp05/MarioKart/pull/${75 + n}`),
    activeMs: 7 * 60 * min + 41 * min,
  },
  trip: {
    turns: 9,
    toolCalls: 231,
    prs: [
      "https://github.com/MattSharp05/TripPlanner/pull/19",
      "https://github.com/MattSharp05/TripPlanner/pull/20",
    ],
    activeMs: 3 * 60 * min + 5 * min,
  },
  "mk-80-builder": { turns: 1, toolCalls: 48, prs: [], activeMs: 9 * min },
  session_01SM: { turns: 3, toolCalls: 77, prs: [], activeMs: 52 * min },
  "virtual-assistant": {
    turns: 6,
    toolCalls: 190,
    prs: ["https://github.com/MattSharp05/VirtualAssistant/pull/17"],
    activeMs: 2 * 60 * min + 18 * min,
  },
  "notes-cleanup": {},
};

// The project each row names (JD-72), as the server derives it: the project:<name> tag, else the
// repo's name. notes-cleanup has neither, so it lands in "No project".
const projects: Record<string, string> = {
  mk: "MarioKart",
  trip: "Trip planner",
  "mk-80-builder": "MarioKart",
  session_01SM: "ShapeMint",
  "virtual-assistant": "JARVIS Desk",
};

for (const s of sessions) {
  s.metrics = rowMetrics[s.id];
  if (projects[s.id]) s.project = projects[s.id];
}

const activity = (items: [number, SessionDetail["activity"]["items"][number]["role"], string][]) => ({
  available: true,
  items: items.map(([min, role, text]) => ({ at: ago(min), role, text })),
});

const report = (min: number, kind: SessionReport["kind"], text: string): SessionReport => ({
  at: ago(min),
  kind,
  text,
});

const details: Record<string, Omit<SessionDetail, "session" | "link">> = {
  mk: {
    activity: activity([
      [22, "assistant", "Started the MK-81 builder; reading the PRD speed section."],
      [18, "tool", "used Bash"],
      [16, "assistant", "npm test: 2 failing, drift boost at 1.5× breaks the 1.2× cap in the PRD."],
      [14, "assistant", "Blocking MK-81 and asking Matthew."],
      [13, "tool", "used notion-update-page"],
      [12, "assistant", "Reported to JARVIS."],
    ]),
    reports: [
      report(
        12,
        "blocked",
        "⛔ MK-81 blocked: drift boost vs the PRD speed cap. Options: (a) keep it, cap at 1.2× (b) cut it for v1. Recommend (a).",
      ),
      report(41, "info", "✅ MK-79 merged · CI green · 4/6 in wave 3"),
    ],
  },
  trip: {
    activity: activity([
      [55, "assistant", "Merged TR-19 and TR-20; main is green."],
      [44, "tool", "used notion-update-page"],
      [40, "assistant", "Batch 3 done. Handing 6 tickets to QA."],
    ]),
    reports: [report(40, "finished", "Batch 3 done · 6 tickets ready for QA, test order in the handover")],
  },
  "mk-80-builder": {
    activity: activity([
      [9, "user", "Build MK-80: track hazards (oil slicks, banana peels)."],
      [4, "tool", "used Edit"],
      [1, "assistant", "Hazards placed; running the physics tests."],
    ]),
    reports: [report(1, "info", "MK-80 · track hazards · running tests")],
  },
  session_01SM: {
    activity: activity([
      [14, "assistant", "Split the exporter into encode and upload steps."],
      [6, "tool", "used Bash"],
    ]),
    reports: [],
  },
  "virtual-assistant": {
    activity: activity([
      [140, "assistant", "JD-17 merged; worker brain and Today digest are live."],
      [130, "assistant", "Reported to JARVIS."],
    ]),
    reports: [report(130, "info", "JD-17 merged ✅")],
  },
  "notes-cleanup": {
    activity: { available: false, items: [], reason: "no readable messages in the session history" },
    reports: [],
  },
};

const data: Record<string, unknown> = { "/sessions": sessions };
for (const s of sessions) {
  const session = s.metrics ? { ...s, metrics: { ...s.metrics, ...activityMetrics[s.id] } } : s;
  data[`/sessions/${s.id}`] = { session, link: s.url, ...details[s.id] } satisfies SessionDetail;
  data[`/sessions/${s.id}/send`] = {
    ok: true,
    name: s.name ?? "shapemint",
    ms: 900,
  } satisfies SessionSendResponse;
}

const part: ScenarioPart = {
  data,
  events: [
    {
      after: 4000,
      event: {
        type: "notice",
        at: "2026-10-14T09:15:00Z",
        level: "info",
        title: "mk merged MK-74 ✅",
        body: "3/5 tickets in this batch",
      },
    },
  ],
};

export default part;
