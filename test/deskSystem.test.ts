import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SystemResponse } from "@jarvis/shared";
import type { Config } from "../src/config.js";
import { DeviceStore } from "../src/desk/auth.js";
import { DeskRpc } from "../src/desk/rpc.js";
import { DeskRouter, type DeskContext } from "../src/desk/routes/index.js";
import { startOfDay, usageSince } from "../src/desk/routes/system.js";
import { SseHub } from "../src/desk/sse.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store, type BrainMessage } from "../src/store.js";
import { SystemMonitor, useSystemMonitor } from "../src/system.js";
import { createDashboard } from "../src/web.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-system-"));

/** A fake `claude`: logged in, and answers get_usage with 75% of the 5-hour window and 92% of the week. */
function fakeClaude(dir: string): string {
  const bin = join(dir, "claude");
  const usage = JSON.stringify({
    type: "control_response",
    response: {
      request_id: "usage",
      subtype: "success",
      response: {
        rate_limits: {
          five_hour: { utilization: 75, resets_at: "2026-10-14T12:00:00Z" },
          seven_day: { utilization: 92, resets_at: "2026-10-18T00:00:00Z" },
        },
      },
    },
  });
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true}'; exit 0; fi\necho '${usage}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function config(dataDir: string, claudeBin: string): Config {
  return {
    telegramBotToken: undefined, allowedChatId: undefined, routineId: "r1", routineToken: "t", dataDir, claudeBin,
    dashboardPort: 0, dashboardPassword: undefined, reportSecret: undefined, reportsPort: 0, notionToken: undefined,
    brainModels: ["claude-haiku-5-5"], brainModel: "claude-haiku-5-5", brainWarm: false, brainConnectors: [],
  };
}

const metrics = (inputTokens: number, outputTokens: number, turns: number, ms: number) => ({
  ms, model: "m", inputTokens, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens, turns,
});

test("usageSince sums today's replies and skips older ones and plain messages", () => {
  const now = new Date(2026, 9, 14, 15, 0);
  const since = startOfDay(now);
  assert.equal(since, new Date(2026, 9, 14).getTime());
  const messages: BrainMessage[] = [
    { at: new Date(2026, 9, 13, 23, 0).toISOString(), from: "jarvis", channel: "telegram", text: "old", metrics: metrics(1000, 10, 1, 500) },
    { at: new Date(2026, 9, 14, 9, 0).toISOString(), from: "you", channel: "telegram", text: "hi" },
    { at: new Date(2026, 9, 14, 9, 1).toISOString(), from: "jarvis", channel: "telegram", text: "a", metrics: metrics(2000, 50, 2, 1200) },
    { at: new Date(2026, 9, 14, 10, 0).toISOString(), from: "jarvis", channel: "desk-typed", text: "b", metrics: metrics(3000, 70, 1, 800) },
  ];
  assert.deepEqual(usageSince(messages, since), { replies: 2, tokens: 2000 + 100 + 50 + 3000 + 100 + 70, turns: 3, ms: 2000 });
});

test("GET /api/desk/system: plan, fires, container, chat vs worker today, devices", async () => {
  const dir = tmp();
  const jarvis = new Jarvis(config(dir, fakeClaude(dir)), new Store(dir));
  const today = new Date();
  jarvis.store.addBrainMessage({ at: today.toISOString(), from: "jarvis", channel: "telegram", text: "hi", metrics: metrics(1000, 20, 2, 900) });
  jarvis.store.recordFire();
  jarvis.store.recordFire();
  writeFileSync(
    join(dir, "worker.json"),
    JSON.stringify({ state: { messages: [{ at: today.toISOString(), from: "jarvis", channel: "worker", text: "ok", metrics: metrics(5000, 300, 4, 6000) }], totals: {} } }),
  );
  // Two hourly snapshots of one session today (JD-55).
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(
    join(dir, "session-usage.jsonl"),
    [
      { at: hourAgo, sessionId: "session_01A", project: "jarvis", costUsd: 1, tokens: 100, updatedAt: hourAgo },
      { at: today.toISOString(), sessionId: "session_01A", project: "jarvis", costUsd: 3.5, tokens: 350, working: true },
    ].map((l) => JSON.stringify(l) + "\n").join(""),
  );
  // A container with 400 MB of 512 MB in use (cgroup v2 files).
  const cg = join(dir, "cgroup");
  mkdirSync(cg);
  writeFileSync(join(cg, "memory.current"), String(400 * 2 ** 20));
  writeFileSync(join(cg, "memory.max"), String(512 * 2 ** 20));
  writeFileSync(join(cg, "memory.peak"), String(450 * 2 ** 20));
  writeFileSync(join(cg, "memory.stat"), "inactive_file 0\n");
  writeFileSync(join(cg, "cpu.stat"), "usage_usec 1000\n");
  const monitor = new SystemMonitor(cg, join(dir, "no-proc"));
  monitor.record();
  useSystemMonitor(jarvis, monitor);

  const bus = new EventBus();
  const ctx: DeskContext = { jarvis, bus, devices: new DeviceStore(dir), hub: new SseHub(bus), rpc: new DeskRpc(bus) };
  const { key } = await ctx.devices.pair("Matthew's Mac");
  const server = createDashboard(jarvis, { desk: { router: await DeskRouter.discover(), ctx } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/desk/system`)).status, 401);
    const res = await fetch(`${base}/api/desk/system`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as SystemResponse;
    assert.deepEqual(body.plan, {
      available: true, fiveHour: 75, weekly: 92, resetsAt: "2026-10-14T12:00:00Z", weeklyResetsAt: "2026-10-18T00:00:00Z",
    });
    assert.equal(body.fires.configured, true);
    assert.equal(body.fires.used, 2);
    assert.equal(body.fires.limit, 30);
    assert.ok(body.fires.nextFreeAt && Date.parse(body.fires.nextFreeAt) > Date.now());
    assert.equal(body.container.memUsed, 400 * 2 ** 20);
    assert.equal(body.container.memLimit, 512 * 2 ** 20);
    assert.equal(body.container.memPeak, 450 * 2 ** 20);
    assert.equal(body.container.claudeProcs, 0);
    assert.equal(body.container.memHistory.length, 1);
    assert.equal(body.container.memHistory[0].memUsed, 400 * 2 ** 20);
    assert.deepEqual(body.brain.chatToday, { replies: 1, tokens: 1120, turns: 2, ms: 900 });
    assert.deepEqual(body.brain.workerToday, { replies: 1, tokens: 5400, turns: 4, ms: 6000 });
    assert.deepEqual(body.devices.map((d) => d.name), ["Matthew's Mac"]);
    assert.deepEqual(body.projects?.map((p) => [p.project, p.activeSessions, p.allTime.costUsd, p.allTime.tokens]), [["jarvis", 1, 3.5, 350]]);
    assert.equal(body.history?.length, 30);
    assert.equal(body.history?.reduce((n, d) => n + d.costUsd, 0), 3.5);
    assert.deepEqual(body.voiceLatency, { turns: 0, p50: null, p90: null, stages: [] }, "no voice turns reported yet");
    // The Desk reports a voice turn (JD-48); the next GET summarises it.
    const reported = await fetch(`${base}/api/desk/system/latency`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ at: new Date().toISOString(), trigger: "ptt", speechMs: 1500, stages: { transcript: 400, audioStart: 2300 } }),
    });
    assert.equal(reported.status, 200);
    const after = (await (await fetch(`${base}/api/desk/system`, { headers: { authorization: `Bearer ${key}` } })).json()) as SystemResponse;
    assert.equal(after.voiceLatency?.turns, 1);
    assert.equal(after.voiceLatency?.p50, 2300);
  } finally {
    ctx.hub.close();
    server.closeAllConnections();
    server.close();
  }
});
