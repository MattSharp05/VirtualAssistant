import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { describeEvent } from "../src/activity.js";
import { Brain, formatMetrics, parseCliResult } from "../src/brain/index.js";
import { connectorTools } from "../src/tools/connectors.js";
import { ToolRegistry } from "../src/tools/index.js";
import type { Config } from "../src/config.js";
import { Jarvis } from "../src/jarvis.js";
import { blockText, Notion, NotionStatusCache, propertyText } from "../src/notion.js";
import { Store } from "../src/store.js";
import { createDashboard } from "../src/web.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-brain-"));

function config(dataDir: string): Config {
  return {
    telegramBotToken: undefined, allowedChatId: undefined, routineId: undefined, routineToken: undefined,
    dataDir, claudeBin: "/bin/false", dashboardPort: 0, dashboardPassword: undefined, reportSecret: undefined,
    reportsPort: 0, notionToken: undefined, brainWarm: false, brainModels: ["claude-sonnet-5-5", "claude-haiku-5-5"], brainModel: "claude-sonnet-5-5", brainConnectors: [],
  };
}

test("the MCP tool server answers the handshake, lists tools and calls the internal API", async () => {
  const dir = tmp();
  const store = new Store(dir);
  const jarvis = new Jarvis(config(dir), store);
  store.addReport("mk", "MK-74 merged ✅ — 3/5", "cse_01MK");
  const registry = await ToolRegistry.discover();
  const server = createDashboard(jarvis, { registry, toolContext: { jarvis, config: jarvis.config }, internalToken: "itok" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mcpPath = fileURLToPath(new URL("../src/mcp.js", import.meta.url));
  const child = spawn(process.execPath, [mcpPath], { env: { ...process.env, JARVIS_INTERNAL_URL: base, JARVIS_INTERNAL_TOKEN: "itok" } });
  const lines = createInterface({ input: child.stdout });
  const replies: Record<string, unknown>[] = [];
  const next = () => new Promise<Record<string, unknown>>((resolve) => {
    const tick = () => (replies.length ? resolve(replies.shift()!) : setTimeout(tick, 10));
    tick();
  });
  lines.on("line", (l) => replies.push(JSON.parse(l)));
  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    const init = (await next()).result as { serverInfo: { name: string } };
    assert.equal(init.serverInfo.name, "jarvis");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = ((await next()).result as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ["overview", "list_cloud_sessions", "session_activity", "send_to_session", "start_session", "notion_search", "notion_read_page", "notion_query_database", "add_task", "complete_task", "list_tasks", "update_task"].sort());
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "overview", arguments: {} } });
    const overview = (await next()).result as { content: { text: string }[] };
    assert.match(overview.content[0].text, /mk \[reported\]/);
    assert.match(overview.content[0].text, /MK-74 merged/);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "notion_search", arguments: { query: "PRD" } } });
    const notion = (await next()).result as { isError: boolean; content: { text: string }[] };
    assert.equal(notion.isError, true);
    assert.match(notion.content[0].text, /NOTION_TOKEN is not set/);
  } finally {
    child.kill();
    server.closeAllConnections();
    server.close();
  }
});

test("the internal API needs its token (and loopback)", async () => {
  const dir = tmp();
  const jarvis = new Jarvis(config(dir), new Store(dir));
  const server = createDashboard(jarvis, { registry: await ToolRegistry.discover(), toolContext: { jarvis, config: jarvis.config }, internalToken: "itok" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/tools`;
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status, 403);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer itok" } })).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("the brain calls the CLI locked down, resumes the conversation and records metrics", async () => {
  const dir = tmp();
  const log = join(dir, "argv.log");
  const bin = join(dir, "claude");
  // A stand-in CLI: logs its argv, echoes the prompt it got on stdin, prints a result like `claude -p --output-format json`.
  writeFileSync(bin, `#!/bin/sh
for a in "$@"; do printf '%s ' "$(printf '%s' "$a" | tr '\\n' ' ')"; done >> ${log}; echo >> ${log}
prompt=$(cat)
cat <<JSON
{"type":"result","is_error":false,"result":"mk merged MK-74; 2 builders running.","duration_ms":4200,"num_turns":3,"total_cost_usd":0.012,"session_id":"x","usage":{"input_tokens":120,"cache_creation_input_tokens":2000,"cache_read_input_tokens":16000,"output_tokens":212}}
JSON
`);
  chmodSync(bin, 0o755);
  const store = new Store(dir);
  const brain = new Brain(
    { claudeBin: bin, dataDir: dir, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], defaultModel: "claude-sonnet-5-5", internalUrl: "http://127.0.0.1:1", internalToken: "t", warm: false },
    store,
  );
  const first = await brain.chat("what's mk up to?", "telegram");
  assert.equal(first.reply, "mk merged MK-74; 2 builders running.");
  assert.equal(first.metrics.cacheReadTokens, 16000);
  assert.equal(formatMetrics(first.metrics), "⏱ 4.2s · 🔢 18k in (16k cached) · 212 out · sonnet · 3 steps");
  brain.setModel("claude-haiku-5-5");
  await brain.chat("and shapemint?", "dashboard");

  const [call1, call2] = readFileSync(log, "utf8").trim().split("\n");
  assert.match(call1, /--tools {2}--strict-mcp-config/, "built-in tools disabled with an empty --tools");
  assert.match(call1, /--allowedTools mcp__jarvis/);
  assert.match(call1, /--model claude-sonnet-5-5/);
  assert.match(call1, /--session-id [0-9a-f-]{36}/);
  assert.match(call2, /--model claude-haiku-5-5/);
  const sessionId = /--session-id ([0-9a-f-]{36})/.exec(call1)![1];
  assert.match(call2, new RegExp(`--resume ${sessionId}`), "second message resumes the same conversation");

  const state = store.brain();
  assert.equal(state.messages.length, 4);
  assert.equal(state.totals.replies, 2);
  assert.equal(state.totals.outputTokens, 424);
  brain.reset();
  assert.equal(store.brain().sessionId, undefined);
  assert.throws(() => brain.setModel("gpt-5"), /Unknown model/);
});

test("parseCliResult tolerates noise before the JSON", () => {
  assert.equal(parseCliResult('warning: something\n{"type":"result","result":"hi"}')?.result, "hi");
  assert.equal(parseCliResult("not json"), undefined);
});

test("Notion blocks and properties render as readable text", async () => {
  assert.equal(blockText({ type: "heading_2", heading_2: { rich_text: [{ plain_text: "Scope" }] } }, 0), "## Scope");
  assert.equal(blockText({ type: "to_do", to_do: { checked: true, rich_text: [{ plain_text: "Ship it" }] } }, 1), "  - [x] Ship it");
  assert.equal(propertyText({ type: "status", status: { name: "In Progress" } }), "In Progress");
  assert.equal(propertyText({ type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] }), "a, b");
  const fakeFetch = (async (url: string) => {
    assert.match(url, /\/v1\/search$/);
    return new Response(JSON.stringify({ results: [{ object: "page", id: "p1", last_edited_time: "2026-10-12T00:00:00Z", properties: { Name: { type: "title", title: [{ plain_text: "Mario Kart PRD" }] } } }] }));
  }) as unknown as typeof fetch;
  assert.match(await new Notion("secret", fakeFetch).search("PRD"), /Mario Kart PRD \(id p1, edited 2026-10-12\)/);
});

test("session history events become readable activity lines", () => {
  assert.deepEqual(describeEvent({ created_at: "2026-10-13T20:00:00Z", payload: { type: "assistant", message: { content: [{ type: "text", text: "Merging MK-74 now." }] } } }), {
    at: "2026-10-13T20:00:00Z", role: "assistant", text: "Merging MK-74 now.",
  });
  assert.equal(describeEvent({ payload: { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } } })?.text, "used Bash");
  assert.equal(describeEvent({ payload: { type: "user", message: { content: [{ type: "tool_result", content: "…" }] } } }), undefined);
  assert.equal(describeEvent({ payload: { type: "system", subtype: "init" } }), undefined);
});

test("the Notion chip's check: off, ok with a page count, rejected token, cached", async () => {
  assert.deepEqual(await new NotionStatusCache(undefined).get(), { state: "off" });
  let calls = 0;
  const ok = (async () => (calls++, new Response(JSON.stringify({ results: [{}, {}, {}], has_more: false })))) as unknown as typeof fetch;
  const cache = new NotionStatusCache("secret", ok);
  assert.deepEqual(await cache.get(), { state: "ok", shared: "3" });
  await cache.get();
  assert.equal(calls, 1, "a working token is re-checked every 5 minutes, not on every dashboard refresh");
  const bad = (async () => new Response(JSON.stringify({ message: "API token is invalid." }), { status: 401 })) as unknown as typeof fetch;
  assert.equal((await new NotionStatusCache("wrong", bad).get()).state, "rejected");
  let shared = 0;
  const sharing = (async () => new Response(JSON.stringify({ results: Array(shared).fill({}), has_more: false }))) as unknown as typeof fetch;
  const fresh = new NotionStatusCache("secret", sharing);
  assert.equal((await fresh.get()).shared, "0");
  shared = 4;
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    assert.equal((await fresh.get()).shared, "4", "0 pages is re-checked after a minute, not five");
  } finally {
    Date.now = realNow;
  }
  const many = (async () => new Response(JSON.stringify({ results: [{}], has_more: true }))) as unknown as typeof fetch;
  assert.equal((await new NotionStatusCache("secret", many).get()).shared, "100+");
});

test("claude.ai connectors: read tools allowed, write tools blocked, strict MCP only without them", async () => {
  const { allowed, blocked } = connectorTools(["google calendar", "Gmail", "Nope"]);
  assert.ok(allowed.includes("mcp__claude_ai_Google_Calendar__list_events"));
  assert.ok(allowed.includes("mcp__claude_ai_Gmail__search_threads"));
  assert.ok(!allowed.some((t) => /send|reply|forward|trash|delete|create|update/.test(t)), "nothing that writes is allowed");
  assert.ok(blocked.includes("mcp__claude_ai_Gmail__send_message"));
  assert.ok(blocked.includes("mcp__claude_ai_Google_Calendar__delete_event"));
  const slack = connectorTools(["Slack"]);
  assert.ok(slack.allowed.includes("mcp__claude_ai_Slack__slack_read_channel"));
  assert.ok(!slack.allowed.some((t) => /send|schedule|add_|create|update|upload/.test(t)), "nothing that posts is allowed");
  assert.ok(slack.blocked.includes("mcp__claude_ai_Slack__slack_send_message"));

  const dir = tmp();
  const log = join(dir, "argv.log");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh
for a in "$@"; do printf '%s ' "$(printf '%s' "$a" | tr '\\n' ' ')"; done >> ${log}; echo >> ${log}
cat >/dev/null
echo '{"type":"result","result":"ok","usage":{}}'
`);
  chmodSync(bin, 0o755);
  const base = { claudeBin: bin, dataDir: dir, models: ["claude-haiku-5-5"], defaultModel: "claude-haiku-5-5", internalUrl: "http://127.0.0.1:1", internalToken: "t", warm: false };
  const store = new Store(dir);
  const registry = await ToolRegistry.discover();
  const toolContext = { jarvis: new Jarvis({ ...config(dir), brainConnectors: ["Google Calendar", "Gmail"] }, store), config: { ...config(dir), brainConnectors: ["Google Calendar", "Gmail"] } };
  await new Brain({ ...base, setup: () => registry.brainSetup(toolContext) }, store).chat("what's on today?", "telegram");
  const call = readFileSync(log, "utf8").trim();
  assert.doesNotMatch(call, /--strict-mcp-config/, "claude.ai connectors need the non-strict MCP mode");
  assert.match(call, /--allowedTools mcp__jarvis,mcp__claude_ai_Google_Calendar__list_calendars,/);
  assert.match(call, /--disallowedTools \S*mcp__claude_ai_Gmail__send_message/);
});
