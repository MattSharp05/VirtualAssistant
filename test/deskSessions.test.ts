import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent, DeskSession, SessionDetail } from "@jarvis/shared";
import type { Config } from "../src/config.js";
import { DeviceStore } from "../src/desk/auth.js";
import { DeskRpc } from "../src/desk/rpc.js";
import { DeskRouter, type DeskContext } from "../src/desk/routes/index.js";
import { groupFor, IDLE_AFTER_MS, mergeSessions } from "../src/desk/routes/sessions.js";
import { SseHub } from "../src/desk/sse.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Notifier } from "../src/notify.js";
import { ReportWatcher } from "../src/notifyRules.js";
import { SessionMetricsSource } from "../src/sessionMetrics.js";
import type { CloudSession } from "../src/sessions.js";
import { Store, type Job } from "../src/store.js";
import { createDashboard } from "../src/web.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-desk-sessions-"));
// No claude.ai login: session history answers "unavailable" instead of reaching the network.
process.env.CLAUDE_CONFIG_DIR = tmp();

const NOW = Date.parse("2026-10-14T09:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

test("grouping: a blocked/decision/QA-ready report needs you; activity under 30 min is working; else idle", () => {
  assert.equal(groupFor("blocked", ago(500), NOW), "needs-you");
  assert.equal(groupFor("decision", undefined, NOW), "needs-you");
  assert.equal(groupFor("finished", ago(2), NOW), "needs-you", "a batch ready for QA waits on Matthew");
  assert.equal(groupFor("info", ago(5), NOW), "working");
  assert.equal(groupFor("failed", ago(29), NOW), "working");
  assert.equal(groupFor(undefined, new Date(NOW - IDLE_AFTER_MS).toISOString(), NOW), "idle");
  assert.equal(groupFor("info", ago(120), NOW), "idle");
  assert.equal(groupFor(undefined, undefined, NOW), "idle");
});

test("merge: cloud sessions and tracked jobs become one list, needs-you first, newest activity first", () => {
  const cloud: CloudSession[] = [
    { id: "session_01MK", title: "Mario Kart orchestrator", status: "running", lastActivityAt: ago(50), url: "https://claude.ai/code/session_01MK" },
    { id: "session_01SM", title: "ShapeMint builder", status: "running", lastActivityAt: ago(3), url: "https://claude.ai/code/session_01SM" },
    { id: "session_01OLD", title: "Notes cleanup", lastActivityAt: ago(600), url: "https://claude.ai/code/session_01OLD" },
  ];
  const jobs: Job[] = [
    { id: "mk", sessionId: "session_01MK", url: "https://claude.ai/code/session_01MK", task: "Attached", createdAt: ago(900), kind: "attached" },
    { id: "trip", sessionId: "session_01TR", url: "https://claude.ai/code/session_01TR", task: "Trip planner", createdAt: ago(900), kind: "reported" },
  ];
  const reports = [
    { jobId: "mk", text: "MK-79 merged ✅", receivedAt: ago(60) },
    { jobId: "mk", text: "⛔ MK-81 blocked: drift boost vs the speed cap\nOptions: (a) (b)", receivedAt: ago(12) },
    { jobId: "trip", text: "TR-20 merged", receivedAt: ago(40) },
  ];
  const list = mergeSessions(cloud, jobs, reports, NOW);
  assert.deepEqual(
    list.map((s) => [s.id, s.group]),
    [
      ["mk", "needs-you"],
      ["session_01SM", "working"],
      ["trip", "idle"],
      ["session_01OLD", "idle"],
    ],
  );
  const mk = list[0];
  assert.equal(mk.name, "mk");
  assert.equal(mk.title, "Mario Kart orchestrator");
  assert.equal(mk.status, "running");
  assert.equal(mk.lastActivity, ago(12), "the newest report beats the cloud list's older last event");
  assert.equal(mk.latestReport, "⛔ MK-81 blocked: drift boost vs the speed cap");
  assert.equal(mk.latestKind, "blocked");
  assert.equal(list[1].name, undefined, "untracked sessions have no name");
  assert.equal(list[2].title, "Trip planner", "a tracked job the cloud list misses still shows, titled by its task");
});

/** A fake `claude`: `agents --json` lists two cloud sessions; `-p --cloud` records the message and answers ok. */
function fakeClaude(dir: string): { bin: string; log: string } {
  const bin = join(dir, "claude");
  const log = join(dir, "sent");
  const agents = JSON.stringify([
    { sessionId: "session_01MK", title: "Mario Kart orchestrator", status: "running", lastEventAt: new Date(Date.now() - 3 * 60_000).toISOString() },
    { sessionId: "session_01SM", title: "ShapeMint builder", status: "idle", lastEventAt: new Date(Date.now() - 5 * 3600_000).toISOString() },
  ]);
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "agents" ]; then printf '%s\\n' '${agents}'; exit 0; fi\necho "$@" >> ${log}\ncat >> ${log}\nprintf '%s\\n' '{"ok":true,"session_id":"x"}'\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

async function start() {
  const dir = tmp();
  const { bin, log } = fakeClaude(dir);
  const config = { dataDir: dir, claudeBin: bin, dashboardPort: 0 } as unknown as Config;
  const store = new Store(dir);
  const jarvis = new Jarvis(config, store);
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const ctx: DeskContext = { jarvis, bus, devices: new DeviceStore(dir), hub: new SseHub(bus), rpc: new DeskRpc(bus) };
  const server = createDashboard(jarvis, { desk: { router: await DeskRouter.discover(), ctx } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desk`;
  const { key } = await ctx.devices.pair("Mac");
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const get = (path: string) => fetch(`${base}${path}`, { headers });
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const stop = () => {
    ctx.hub.close();
    server.closeAllConnections();
    server.close();
  };
  const dashboard = (path: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  return { jarvis, store, bus, events, log, get, post, dashboard, stop };
}

test("GET /sessions and /sessions/:id: grouped list, reports newest first, activity unavailable without a login", async (t) => {
  const s = await start();
  t.after(s.stop);
  s.jarvis.attachSession("https://claude.ai/code/session_01MK", "mk");
  for (let i = 1; i <= 6; i++) s.store.addReport("mk", `MK-${70 + i} merged ✅`);
  s.store.addReport("mk", "⛔ MK-81 blocked: drift boost vs the speed cap");

  const list = (await (await s.get("/sessions")).json()) as DeskSession[];
  assert.deepEqual(
    list.map((x) => [x.id, x.group, x.latestReport]),
    [
      ["mk", "needs-you", "⛔ MK-81 blocked: drift boost vs the speed cap"],
      ["session_01SM", "idle", undefined],
    ],
  );

  const detail = (await (await s.get("/sessions/mk")).json()) as SessionDetail;
  assert.equal(detail.session.title, "Mario Kart orchestrator");
  assert.equal(detail.link, "https://claude.ai/code/session_01MK");
  assert.deepEqual(
    detail.reports.map((r) => [r.text, r.kind]),
    [
      ["⛔ MK-81 blocked: drift boost vs the speed cap", "blocked"],
      ["MK-76 merged ✅", "info"],
      ["MK-75 merged ✅", "info"],
      ["MK-74 merged ✅", "info"],
      ["MK-73 merged ✅", "info"],
    ],
  );
  assert.equal(detail.activity.available, false);
  assert.match(detail.activity.reason ?? "", /login/);

  // Untracked sessions are found by their cloud id; unknown ones are 404.
  assert.equal(((await (await s.get("/sessions/session_01SM")).json()) as SessionDetail).reports.length, 0);
  assert.equal((await s.get("/sessions/nope")).status, 404);
});

test("JD-53: rows carry tokens, cost, context, wall time and status; the detail adds activity; no usage = unknown", async (t) => {
  const s = await start();
  t.after(s.stop);
  s.jarvis.attachSession("https://claude.ai/code/session_01MK", "mk");
  const created = new Date(Date.now() - 90 * 60_000).toISOString();
  const bodies: Record<string, unknown> = {
    "/v1/code/sessions/session_01MK": {
      status_bucket: "SESSION_STATUS_BUCKET_WORKING",
      created_at: created,
      external_metadata: {
        usage: { input_tokens: 100, output_tokens: 200, cache_read_tokens: 3000, cache_write_tokens: 400, cost_usd: 1.5 },
        context_usage: { used_tokens: 250_000, max_tokens: 1_000_000 },
      },
    },
    // An older session: no usage or context at all.
    "/v1/code/sessions/session_01SM": { status_bucket: "SESSION_STATUS_BUCKET_REVIEW_READY", created_at: created },
    "/v1/code/sessions/session_01MK/events": {
      data: [
        { id: "e1", created_at: created, data: { type: "user", message: { content: "Build MK-81" } } },
        { id: "e2", created_at: created, data: { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } } },
        { id: "e3", created_at: created, data: { type: "user", message: { content: [{ type: "tool_result", content: "https://github.com/o/mk/pull/81" }] } } },
      ],
      has_more: false,
    },
  };
  const fakeFetch = (async (input: string | URL) => {
    const body = bodies[new URL(String(input)).pathname];
    return new Response(JSON.stringify(body ?? { error: "not found" }), { status: body ? 200 : 404 });
  }) as typeof fetch;
  s.jarvis.metrics = new SessionMetricsSource({ fetchImpl: fakeFetch, token: () => "tok" });

  const list = (await (await s.get("/sessions")).json()) as DeskSession[];
  const mk = list.find((x) => x.id === "mk")!.metrics!;
  assert.equal(mk.totalTokens, 3700);
  assert.equal(mk.costUsd, 1.5);
  assert.equal(mk.contextPercent, 25);
  assert.equal(mk.statusBucket, "working");
  assert.ok(mk.wallMs! >= 90 * 60_000 - 1000);
  assert.equal(mk.turns, undefined, "activity is detail only");
  const sm = list.find((x) => x.id === "session_01SM")!.metrics!;
  assert.equal(sm.statusBucket, "review_ready");
  assert.ok(!("costUsd" in sm) && !("totalTokens" in sm) && !("contextPercent" in sm), "unknown, not 0");

  const detail = (await (await s.get("/sessions/mk")).json()) as SessionDetail;
  assert.equal(detail.session.metrics?.turns, 1);
  assert.equal(detail.session.metrics?.toolCalls, 1);
  assert.deepEqual(detail.session.metrics?.prs, ["https://github.com/o/mk/pull/81"]);
  assert.ok((detail.session.metrics?.activeMs ?? 0) >= 90 * 60_000 - 1000, "the open turn counts to now");

  // The dashboard API gets the same.
  const dash = (await (await s.dashboard("/api/sessions")).json()) as { sessions: { id: string; metrics?: { costUsd?: number } }[] };
  assert.equal(dash.sessions.find((x) => x.id === "session_01MK")?.metrics?.costUsd, 1.5);
  const one = (await (await s.dashboard("/api/sessions/metrics?id=session_01MK")).json()) as { turns?: number };
  assert.equal(one.turns, 1);
  assert.equal((await s.dashboard("/api/sessions/metrics?id=nope")).status, 400);
});

test("POST /sessions/:id/send goes through the CLI, tracks an untracked session, and publishes sessions.changed", async (t) => {
  const s = await start();
  t.after(s.stop);
  s.jarvis.attachSession("https://claude.ai/code/session_01MK", "mk");

  const res = await s.post("/sessions/mk/send", { text: "Go with (a)" });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { name: string }).name, "mk");
  const sent = readFileSync(s.log, "utf8");
  assert.match(sent, /--cloud session_01MK/);
  assert.match(sent, /Go with \(a\)/);
  assert.ok(s.events.some((e) => e.type === "sessions.changed"));

  const picked = await s.post("/sessions/session_01SM/send", { text: "status?" });
  assert.equal(((await picked.json()) as { name: string }).name, "shapemint-builder", "named from its title");
  assert.ok(s.store.getJob("shapemint-builder"));

  assert.equal((await s.post("/sessions/mk/send", { text: "  " })).status, 400);
  assert.equal((await s.post("/sessions/nope/send", { text: "hi" })).status, 404);
});

test("a new report publishes sessions.changed", async () => {
  const dir = tmp();
  const store = new Store(dir);
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const watcher = new ReportWatcher(store, bus, new Notifier(bus));
  watcher.start();
  try {
    store.addReport("mk", "Wave 4 in progress", "session_01MK");
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(events.some((e) => e.type === "sessions.changed"));
  } finally {
    watcher.stop();
  }
});
