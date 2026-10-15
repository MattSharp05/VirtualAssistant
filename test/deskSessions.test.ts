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
  return { jarvis, store, bus, events, log, get, post, stop };
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
