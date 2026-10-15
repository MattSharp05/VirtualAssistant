// Cloud sessions JARVIS tracks (JD-32, mockup 4), typed as the server's Desk API so the preview and
// the real thing match. Times are relative to when the preview loads (e2e fixes the clock).
import type { DeskSession, SessionDetail, SessionReport, SessionSendResponse } from "@jarvis/shared";
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
  data[`/sessions/${s.id}`] = { session: s, link: s.url, ...details[s.id] } satisfies SessionDetail;
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
