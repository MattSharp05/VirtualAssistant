import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent, Digest, TodayResponse } from "@jarvis/shared";
import { createWorker, WORKER_PROMPT, WorkerState } from "../src/brain/worker.js";
import type { Config } from "../src/config.js";
import todayRoutes from "../src/desk/routes/today.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { discoverJobs, JobRunner, useJobRunner } from "../src/jobs/index.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import type { PlanUsage } from "../src/usage.js";
import { createDashboard } from "../src/web.js";

const GOOD = {
  events: [
    { start: "2026-10-14T12:30:00+01:00", end: "2026-10-14T13:30:00+01:00", title: "Lunch with Sam", calendar: "Personal" },
    { start: "2026-10-14T09:30:00+01:00", end: "2026-10-14T09:45:00+01:00", title: "Standup", calendar: "Work" },
  ],
  inbox: [{ from: "Priya", subject: "Onboarding copy", line: "Wants a review by Thursday", receivedAt: "2026-10-14T06:58:00Z" }],
  skippedCount: 14,
  slack: [{ who: "Priya", where: "#gogentic", line: "Can you review the copy today?", at: "2026-10-14T08:20:00Z" }],
};

/**
 * A stand-in `claude -p` for the worker: logs its argv, then (like the real CLI's MCP client) calls
 * submit_digest on JARVIS's internal API with the payload in <dir>/payload.json, and prints a result.
 */
function fakeWorkerCli(dir: string): string {
  const bin = join(dir, "claude-worker");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(argv));
const env = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]).mcpServers.jarvis.env;
process.stdin.resume();
process.stdin.on("end", async () => {
  const payload = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "payload.json"))}, "utf8"));
  const res = await fetch(env.JARVIS_INTERNAL_URL + "/internal/tool/submit_digest", {
    method: "POST",
    headers: { authorization: "Bearer " + env.JARVIS_INTERNAL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ args: payload }),
  });
  fs.appendFileSync(${JSON.stringify(join(dir, "tool.log"))}, res.status + " " + (await res.text()) + "\\n");
  console.log(JSON.stringify({ type: "result", result: "submitted", duration_ms: 900, num_turns: 4, usage: { input_tokens: 50, output_tokens: 300 } }));
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-digest-"));
  const config = { dataDir: dir, brainConnectors: ["Google Calendar", "Gmail", "Slack"], claudeBin: "/bin/false" } as unknown as Config;
  const store = new Store(dir);
  const jarvis = new Jarvis(config, store);
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const toolContext = { jarvis, config };
  const registry = await ToolRegistry.discover();
  const server = createDashboard(jarvis, { registry, toolContext, internalToken: "itok" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const worker = createWorker(
    { claudeBin: fakeWorkerCli(dir), dataDir: dir, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], defaultModel: "claude-sonnet-5-5", internalUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, internalToken: "itok" },
    toolContext,
    () => runner.submitToolNames,
  );
  const runner: JobRunner = new JobRunner(await discoverJobs(), worker, toolContext, { dataDir: dir, bus });
  useJobRunner(jarvis, runner);
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { dir, store, jarvis, bus, events, runner, close, payload: (p: unknown) => writeFileSync(join(dir, "payload.json"), JSON.stringify(p)) };
}

test("the worker submits a digest through the real tool path; it's stored, enriched and announced", async (t) => {
  const s = await setup();
  t.after(s.close);
  s.store.addReport("trip", "TR-14 needs a decision: hotel budget cap?", "session_01TRIP");
  s.store.addReport("mk", "MK-74 merged ✅", "session_01MK");
  s.payload(GOOD);

  const result = await s.runner.run("digest");
  const digest = result!.data as Digest;
  assert.deepEqual(digest.events.map((e) => e.title), ["Standup", "Lunch with Sam"], "sorted by start");
  assert.equal(digest.skippedCount, 14);
  assert.deepEqual(digest.tasksDue, [], "no Notion in the test: no tasks, no failure");
  assert.deepEqual(digest.sessionsWaiting.map((w) => [w.job, w.status]), [["trip", "decision"]]);
  assert.equal(digest.sessionsWaiting[0].link, "https://claude.ai/code/session_01TRIP");
  assert.deepEqual(s.events.filter((e) => e.type === "today.updated"), [{ type: "today.updated", generatedAt: digest.generatedAt }]);

  // The worker ran locked down: its own prompt, read tools + submit only, no calendar writes.
  const argv = JSON.parse(readFileSync(join(s.dir, "argv.json"), "utf8")) as string[];
  const flag = (f: string) => argv[argv.indexOf(f) + 1];
  assert.equal(flag("--system-prompt"), WORKER_PROMPT);
  assert.equal(flag("--model"), "claude-haiku-5-5");
  const allowed = flag("--allowedTools").split(",");
  assert.ok(allowed.includes("mcp__jarvis__submit_digest") && allowed.includes("mcp__jarvis__list_tasks"));
  assert.ok(!allowed.includes("mcp__jarvis"), "not every JARVIS tool");
  assert.ok(!allowed.some((a) => /add_task|set_timer|remember|send_to_session|start_session|create_event|update_event|delete_event/.test(a)));
  assert.match(flag("--disallowedTools"), /Google_Calendar__create_event/);

  // The Desk route.
  const ctx = { jarvis: s.jarvis } as unknown as DeskContext;
  const today = (await todayRoutes[0].handler({ ctx } as never)) as TodayResponse;
  assert.equal(today.digest?.generatedAt, digest.generatedAt);
  assert.ok((today.ageSeconds ?? -1) >= 0);
  assert.equal(today.running, false);
});

test("invalid output keeps the previous digest and records the error", async (t) => {
  const s = await setup();
  t.after(s.close);
  s.payload(GOOD);
  const first = (await s.runner.run("digest"))!;
  s.payload({ ...GOOD, events: [{ start: "2026-10-14T09:00:00Z" }] }); // no end, no title
  const second = await s.runner.run("digest");
  assert.equal(second?.at, first.at, "the last good digest stays");
  assert.match(s.runner.lastError("digest")!, /finished without calling submit_digest/);
  assert.match(readFileSync(join(s.dir, "tool.log"), "utf8"), /400 .*events\[0\]\.end is required/, "the worker was told why");
  assert.equal(s.events.filter((e) => e.type === "today.updated").length, 1);
});

test("schedule: every 30 min between 07:00 and 22:00 only; paused at ≥ 90% plan usage", async () => {
  process.env.TZ = "Europe/London";
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sched-"));
  let now = new Date("2026-10-14T05:59:00Z"); // 06:59 BST
  let usage: PlanUsage = { available: true, windows: [{ name: "five_hour", percent: 40 }], checkedAt: "" };
  let runs = 0;
  const worker = { chat: async () => undefined, reset: () => undefined };
  const jobs = await discoverJobs();
  const runner = new JobRunner(jobs, worker, {} as never, { dataDir: dir, now: () => now, usage: async () => usage, timeoutMs: 50 });
  const digest = jobs.find((j) => j.name === "digest")!;
  const origRun = runner.run.bind(runner);
  runner.run = (name: string) => (runs++, origRun(name));

  assert.equal(runner.due(digest), false, "06:59: too early");
  now = new Date("2026-10-14T06:00:00Z"); // 07:00
  assert.deepEqual(await runner.tick(), ["digest"]);
  await new Promise((r) => setTimeout(r, 120)); // let the (failing, fake) run finish
  now = new Date("2026-10-14T06:20:00Z");
  assert.deepEqual(await runner.tick(), [], "20 min later: not yet");
  now = new Date("2026-10-14T06:30:00Z");
  usage = { ...usage, windows: [{ name: "five_hour", percent: 92 }] };
  assert.deepEqual(await runner.tick(), [], "due, but the plan is at 92%");
  usage = { ...usage, windows: [{ name: "five_hour", percent: 60 }] };
  assert.deepEqual(await runner.tick(), ["digest"]);
  now = new Date("2026-10-14T21:05:00Z"); // 22:05
  assert.equal(runner.due(digest), false, "after 22:00");
  assert.equal(runs, 2);
});

test("worker usage is tracked apart from the chat's", async (t) => {
  const s = await setup();
  t.after(s.close);
  s.payload(GOOD);
  await s.runner.run("digest");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.store.brain().totals.replies, 0, "the chat's totals are untouched");
  const worker = new WorkerState(s.dir).brain();
  assert.equal(worker.totals.replies, 1);
  assert.equal(worker.totals.outputTokens, 300);
  assert.equal(worker.messages.at(-1)?.channel, "worker");
});
