import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.js";
import { Jarvis, slugName } from "../src/jarvis.js";
import { listCloudSessions, parseAgentsJson, parseApiPage } from "../src/sessions.js";
import { Store } from "../src/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-picker-"));

function fakeClaude(stdout: string, exitCode = 0): string {
  const bin = join(tmp(), "claude");
  writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("parseAgentsJson keeps cloud sessions and skips local ones", () => {
  const rows = parseAgentsJson(JSON.stringify([
    { pid: 97, kind: "interactive", sessionId: "37a1cbc8-d154-58af-ba76-48cffc39a4d2", name: "user-33", status: "busy" },
    { kind: "cloud", sessionId: "cse_01OLD", title: "ShapeMint orchestrator", status: "idle", lastEventAt: "2026-10-12T10:00:00Z" },
    { kind: "cloud", sessionId: "cse_01NEW", title: "Mario Kart orchestrator", status: "running", lastEventAt: "2026-10-13T10:00:00Z" },
  ]));
  assert.deepEqual(rows.map((r) => r.id), ["cse_01NEW", "cse_01OLD"]);
  assert.equal(rows[0].url, "https://claude.ai/code/cse_01NEW");
});

test("parseApiPage filters like the CLI's picker", () => {
  const rows = parseApiPage({
    data: [
      { id: "cse_01A", title: "Mario Kart orchestrator", status: "running", last_event_at: "2026-10-13T12:00:00Z" },
      { id: "cse_01B", title: "Old thing", status: "archived" },
      { id: "cse_01C", title: "Bridge", environment_kind: "bridge" },
      { id: "cse_01D", title: "__warming__" },
      { id: "cse_01E", title: "" },
      { id: "not-a-session", title: "x" },
      { id: "session_01F", title: "Builder MK-74", status: "idle", created_at: "2026-10-13T11:00:00Z" },
    ],
  });
  assert.deepEqual(rows.map((r) => r.id), ["cse_01A", "session_01F"]);
});

test("listCloudSessions falls back to the API with the stored login", async () => {
  const configDir = tmp();
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-test" } }));
  let headers: Record<string, string> = {};
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ data: [{ id: "cse_01X", title: "Mario Kart orchestrator", status: "running" }] }));
  }) as typeof fetch;
  const list = await listCloudSessions(fakeClaude("[]"), configDir, fakeFetch);
  assert.equal(list.available, true);
  assert.equal(list.source, "api");
  assert.equal(list.sessions[0].title, "Mario Kart orchestrator");
  assert.equal(headers.Authorization, "Bearer sk-ant-oat01-test");
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
});

test("listCloudSessions prefers claude agents and reports why it can't list", async () => {
  const agents = await listCloudSessions(fakeClaude(JSON.stringify([{ sessionId: "cse_01Y", title: "From agents" }])), tmp());
  assert.equal(agents.source, "agents");
  const none = await listCloudSessions(fakeClaude("[]"), tmp());
  assert.equal(none.available, false);
  assert.match(none.reason ?? "", /no claude.ai login found/);
});

test("slugName makes safe job names from titles", () => {
  assert.equal(slugName("Mario Kart orchestrator"), "mario-kart-orchestrator");
  assert.equal(slugName("MK-74: fix drifting physics in the kart controller"), "mk-74-fix-drifting-physi");
  assert.equal(slugName("2026 plan"), "s-2026-plan");
  assert.equal(slugName("!!!"), undefined);
});

test("pickSession reuses a tracked session and dedupes new names", () => {
  const dataDir = tmp();
  const config = {
    telegramBotToken: undefined, allowedChatId: undefined, routineId: undefined, routineToken: undefined,
    dataDir, claudeBin: "/bin/false", dashboardPort: 0, dashboardPassword: undefined, reportSecret: undefined, reportsPort: 0, notionToken: undefined, brainModels: ["claude-sonnet-5-5"], brainModel: "claude-sonnet-5-5", brainConnectors: [],
  } satisfies Config;
  const jarvis = new Jarvis(config, new Store(dataDir));
  const a = jarvis.pickSession("cse_01A", "Mario Kart orchestrator");
  assert.equal(a.id, "mario-kart-orchestrator");
  assert.equal(jarvis.pickSession("cse_01A", "Mario Kart orchestrator").id, a.id, "same session → same job");
  const b = jarvis.pickSession("cse_01B", "Mario Kart orchestrator");
  assert.equal(b.id, "mario-kart-orchestrato-2"); // 24-character cap
  assert.ok(b.id.length <= 24);
  assert.equal(jarvis.store.currentJob()?.id, b.id);
  assert.equal(jarvis.pickSession("cse_01C", "").id, "session");
});
