import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionMetrics } from "@jarvis/shared";
import { parseDetail } from "../src/sessionMetrics.js";
import {
  dayKey,
  increases,
  lastDays,
  projectOf,
  recordSessionUsage,
  rowFor,
  SessionUsageLog,
  summarize,
  type UsageSnapshot,
} from "../src/sessionUsage.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-usage-"));
/** Local times (the server's TZ), so day boundaries hold wherever the tests run. */
const local = (day: number, hour: number, min = 0) => new Date(2026, 9, day, hour, min).toISOString();
const NOW = new Date(2026, 9, 17, 15, 0).getTime();

const snap = (over: Partial<UsageSnapshot> & Pick<UsageSnapshot, "at" | "sessionId">): UsageSnapshot => ({ project: "jarvis", ...over });

test("a session that ran across two days splits its cost across both", () => {
  const s = [
    snap({ at: local(15, 10), sessionId: "a", costUsd: 2, tokens: 200, updatedAt: local(15, 9, 50), createdAt: local(15, 9) }),
    snap({ at: local(15, 20), sessionId: "a", costUsd: 5, tokens: 500 }),
    snap({ at: local(16, 9), sessionId: "a", costUsd: 9, tokens: 900 }),
  ];
  assert.deepEqual(
    increases(s).map(({ day, costUsd, tokens }) => ({ day, costUsd, tokens })),
    [
      { day: "2026-10-15", costUsd: 2, tokens: 200 },
      { day: "2026-10-15", costUsd: 3, tokens: 300 },
      { day: "2026-10-16", costUsd: 4, tokens: 400 },
    ],
  );
  const { history } = summarize(s, NOW);
  assert.equal(history.length, 30);
  assert.equal(history.at(-1)?.day, "2026-10-17");
  const byDay = Object.fromEntries(history.map((d) => [d.day, d]));
  assert.deepEqual(byDay["2026-10-15"], { day: "2026-10-15", costUsd: 5, tokens: 500, projects: { jarvis: { costUsd: 5, tokens: 500 } } });
  assert.deepEqual(byDay["2026-10-16"], { day: "2026-10-16", costUsd: 4, tokens: 400, projects: { jarvis: { costUsd: 4, tokens: 400 } } });
  assert.deepEqual(byDay["2026-10-17"], { day: "2026-10-17", costUsd: 0, tokens: 0, projects: {} });
});

test("use from before the first snapshot goes on the day of its last activity; unknown values carry forward", () => {
  const s = [
    snap({ at: local(16, 8), sessionId: "old", costUsd: 40, tokens: 4000, updatedAt: local(12, 18) }),
    snap({ at: local(16, 9), sessionId: "old", tokens: 4500 }),
    snap({ at: local(16, 10), sessionId: "old", costUsd: 41, tokens: 4500 }),
  ];
  assert.deepEqual(
    increases(s).map(({ day, costUsd, tokens }) => ({ day, costUsd, tokens })),
    [
      { day: "2026-10-12", costUsd: 40, tokens: 4000 },
      { day: "2026-10-16", costUsd: 0, tokens: 500 },
      { day: "2026-10-16", costUsd: 1, tokens: 0 },
    ],
  );
});

test("projects come from the project: tag, then the repository, then Other", () => {
  assert.equal(projectOf({ tags: ["config:x", "project:jarvis"], repo: "MattSharp05/VirtualAssistant" }), "jarvis");
  assert.equal(projectOf({ tags: ["config:x", "project:"], repo: "MattSharp05/VirtualAssistant" }), "VirtualAssistant");
  assert.equal(projectOf({ tags: [] }), "Other");
  assert.equal(projectOf({}), "Other");
  // The repository from the live detail's session context: outcomes first, else the sources' URL.
  const context = {
    sources: [{ git_repository: { url: "https://github.com/MattSharp05/claude-workflow" } }],
    outcomes: [{ git_repository: { git_info: { repo: "MattSharp05/VirtualAssistant", branches: ["b"] } } }],
  };
  assert.equal(parseDetail({ session_context: context }).repo, "MattSharp05/VirtualAssistant");
  assert.equal(parseDetail({ session_context: { sources: context.sources } }).repo, "MattSharp05/claude-workflow");
  assert.equal(parseDetail({ session_context: { sources: [{ git_repository: { url: "https://github.com/o/r.git" } }] } }).repo, "o/r");
  assert.equal(parseDetail({}).repo, undefined);
  const m = (over: Partial<SessionMetrics>): SessionMetrics => ({ checkedAt: local(17, 9), ...over });
  assert.equal(rowFor("s", m({ costUsd: 1, repo: "o/mario-kart" }))?.project, "mario-kart");
  assert.equal(rowFor("s", m({ tags: ["project:jarvis"], totalTokens: 10 }))?.project, "jarvis");
  assert.equal(rowFor("s", m({ model: "x" })), undefined, "nothing about its use known");
});

test("projects: all time from the latest snapshots, this week from the increases, working sessions counted", () => {
  const s = [
    // jarvis: one session over two weeks, one this week, still working.
    snap({ at: local(5, 10), sessionId: "j1", costUsd: 10, tokens: 1000, activeMs: 60_000, wallMs: 3_600_000, createdAt: local(5, 9), updatedAt: local(5, 10) }),
    snap({ at: local(14, 10), sessionId: "j1", costUsd: 30, tokens: 3000, activeMs: 120_000, wallMs: 9 * 86_400_000 + 3_600_000, createdAt: local(5, 9) }),
    snap({ at: local(16, 12), sessionId: "j2", costUsd: 5, tokens: 500, activeMs: 30_000, wallMs: 7_200_000, createdAt: local(16, 10), updatedAt: local(16, 12), working: true }),
    // mario-kart: older than the week only.
    snap({ at: local(2, 10), sessionId: "m1", project: "mario-kart", costUsd: 50, tokens: 9000, wallMs: 60_000, createdAt: local(2, 9), updatedAt: local(2, 10) }),
  ];
  const { projects } = summarize(s, NOW);
  assert.deepEqual(projects.map((p) => p.project), ["mario-kart", "jarvis"], "most expensive first");
  const jarvis = projects[1];
  assert.equal(jarvis.activeSessions, 1);
  assert.deepEqual(jarvis.allTime, { costUsd: 35, tokens: 3500, sessions: 2, wallMs: 9 * 86_400_000 + 3_600_000 + 7_200_000, activeMs: 150_000 });
  // The week (Oct 11–17): j1's increase on the 14th and j2; j1's wall time clipped to the week.
  const weekStart = new Date(2026, 9, 11).getTime();
  const j1End = Date.parse(local(5, 9)) + 9 * 86_400_000 + 3_600_000;
  assert.deepEqual(jarvis.week, { costUsd: 25, tokens: 2500, sessions: 2, wallMs: j1End - weekStart + 7_200_000, activeMs: 90_000 });
  assert.deepEqual(projects[0].week, { costUsd: 0, tokens: 0, sessions: 0, wallMs: 0, activeMs: 0 });
  assert.equal(projects[0].allTime.costUsd, 50);
  assert.deepEqual(lastDays(NOW, 7), ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
  assert.equal(dayKey(NOW), "2026-10-17");
});

test("the log writes only what changed and keeps 90 days plus each session's baseline", () => {
  const dir = tmp();
  let now = new Date(2026, 6, 1, 10).getTime();
  const log = new SessionUsageLog(dir, () => now);
  assert.equal(log.record([{ sessionId: "a", project: "jarvis", costUsd: 1, tokens: 10 }, { sessionId: "b", project: "x", costUsd: 3 }]), 2);
  now += 3_600_000;
  assert.equal(log.record([{ sessionId: "a", project: "jarvis", costUsd: 1, tokens: 10 }, { sessionId: "b", project: "x", costUsd: 3 }]), 0, "nothing changed");
  now += 3_600_000;
  assert.equal(log.record([{ sessionId: "a", project: "jarvis", costUsd: 2, tokens: 20 }]), 1);
  assert.equal(log.list().length, 3);
  // 100 days on: a's two old snapshots become one baseline, b keeps its only one.
  now += 100 * 86_400_000;
  assert.equal(log.record([{ sessionId: "a", project: "jarvis", costUsd: 2.5, tokens: 25 }]), 1);
  const kept = log.list();
  assert.deepEqual(kept.map((s) => [s.sessionId, s.costUsd]), [["b", 3], ["a", 2], ["a", 2.5]]);
  // The baseline is outside the history, so only the new increase shows; all time is still whole.
  const { history, projects } = log.summary();
  assert.equal(history.reduce((n, d) => n + d.costUsd, 0), 0.5);
  assert.equal(projects.find((p) => p.project === "jarvis")?.allTime.costUsd, 2.5);
  // A broken line doesn't lose the rest.
  writeFileSync(log.file, readFileSync(log.file, "utf8") + "not json\n");
  assert.equal(new SessionUsageLog(dir, () => now).list().length, 3);
});

test("recordSessionUsage snapshots the cloud list and tracked jobs with their metrics", async () => {
  const dir = tmp();
  const metrics: Record<string, SessionMetrics> = {
    session_01A: { checkedAt: "x", costUsd: 4, totalTokens: 400, tags: ["project:jarvis"], statusBucket: "working", activeMs: 1000 },
    session_01B: { checkedAt: "x", costUsd: 1, repo: "o/mario-kart" },
  };
  const read: string[] = [];
  const jarvis = {
    listSessions: async () => ({ available: true, sessions: [{ id: "session_01A", title: "a", url: "u" }], checkedAt: "x" }),
    store: { recentJobs: () => [{ sessionId: "session_01B" }, { sessionId: "session_01A" }, { sessionId: "session_01C" }] },
    metrics: {
      full: async (id: string) => {
        read.push(id);
        if (id === "session_01C") throw new Error("api down");
        return metrics[id];
      },
    },
  } as unknown as Parameters<typeof recordSessionUsage>[0];
  const log = new SessionUsageLog(dir, () => NOW);
  assert.equal(await recordSessionUsage(jarvis, log), 2);
  assert.deepEqual(read.sort(), ["session_01A", "session_01B", "session_01C"]);
  const byId = Object.fromEntries(log.list().map((s) => [s.sessionId, s]));
  assert.deepEqual(byId.session_01A, { at: new Date(NOW).toISOString(), sessionId: "session_01A", project: "jarvis", costUsd: 4, tokens: 400, activeMs: 1000, working: true });
  assert.equal(byId.session_01B.project, "mario-kart");
  assert.equal(byId.session_01B.working, false);
});
