import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrainMetrics, ChatHistoryResponse } from "@jarvis/shared";
import { Brain } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import { DeviceStore } from "../src/desk/auth.js";
import { DeskRpc } from "../src/desk/rpc.js";
import chatRoutes, { chatHistory } from "../src/desk/routes/chat.js";
import { DeskRouter, type DeskContext } from "../src/desk/routes/index.js";
import { SseHub } from "../src/desk/sse.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store, type BrainState } from "../src/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-chat-"));

const metrics = (ms: number): BrainMetrics => ({ ms, model: "claude-sonnet-5-5", inputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 90, outputTokens: 50, turns: 1 });

function state(): BrainState {
  return {
    messages: [
      { at: "2026-10-13T21:00:00.000Z", from: "you", channel: "telegram", text: "yesterday" },
      { at: "2026-10-13T21:00:05.000Z", from: "jarvis", channel: "telegram", text: "old reply", metrics: metrics(1000) },
      { at: "2026-10-14T08:58:00.000Z", from: "you", channel: "desk-voice", text: "what did I miss?" },
      { at: "2026-10-14T08:58:05.000Z", from: "jarvis", channel: "desk-voice", text: "Two things.", metrics: metrics(5000), steps: [{ name: "mcp__claude_ai_Slack__slack_search_public", summary: "3 results" }] },
      { at: "2026-10-14T09:04:00.000Z", from: "you", channel: "telegram", text: "how is mk?" },
      { at: "2026-10-14T09:04:06.000Z", from: "jarvis", channel: "telegram", text: "Wave 3 is 4 of 6.", metrics: metrics(3000) },
    ],
    totals: { replies: 0, inputTokens: 0, outputTokens: 0, ms: 0, apiEquivalentUsd: 0 },
  };
}

const now = new Date("2026-10-14T12:00:00Z");

test("chat history: oldest first, paged with before/limit, with channel, steps and metrics", () => {
  const all = chatHistory(state(), { now, timeZone: "UTC" });
  assert.equal(all.messages.length, 6);
  assert.equal(all.hasMore, false);
  assert.equal(all.messages[2].channel, "desk-voice");
  assert.deepEqual(all.messages[3].steps, [{ name: "mcp__claude_ai_Slack__slack_search_public", summary: "3 results" }]);
  assert.equal(all.messages[3].metrics?.ms, 5000);
  assert.equal("steps" in all.messages[5], false);

  const last = chatHistory(state(), { limit: 2, now, timeZone: "UTC" });
  assert.deepEqual(last.messages.map((m) => m.text), ["how is mk?", "Wave 3 is 4 of 6."]);
  assert.equal(last.hasMore, true);
  const earlier = chatHistory(state(), { before: last.messages[0].at, limit: 2, now, timeZone: "UTC" });
  assert.deepEqual(earlier.messages.map((m) => m.text), ["what did I miss?", "Two things."]);
  assert.equal(earlier.hasMore, true);
});

test("chat history: today's totals follow the time zone and a new conversation hides older messages", () => {
  assert.deepEqual(chatHistory(state(), { now, timeZone: "UTC" }).today, { replies: 2, inputTokens: 2000, outputTokens: 100, ms: 8000 });
  // 21:00 UTC on the 13th is already the 14th in Tokyo.
  assert.equal(chatHistory(state(), { now, timeZone: "Asia/Tokyo" }).today.replies, 3);

  const reset = { ...state(), conversationStartedAt: "2026-10-14T09:00:00.000Z" };
  const page = chatHistory(reset, { now, timeZone: "UTC" });
  assert.deepEqual(page.messages.map((m) => m.text), ["how is mk?", "Wave 3 is 4 of 6."]);
  assert.equal(page.today.replies, 2, "today's totals still count the earlier conversation");
});

function config(dataDir: string): Config {
  return {
    telegramBotToken: undefined, allowedChatId: undefined, routineId: undefined, routineToken: undefined,
    dataDir, claudeBin: "/bin/false", dashboardPort: 0, dashboardPassword: undefined, reportSecret: undefined,
    reportsPort: 0, notionToken: undefined, brainModels: ["claude-sonnet-5-5", "claude-haiku-5-5"], brainModel: "claude-sonnet-5-5", brainWarm: false, brainConnectors: [],
  };
}

/** Calls the router directly with a fake request/response, as an authenticated Desk. */
async function call(router: DeskRouter, ctx: DeskContext, key: string, method: string, path: string, body: Record<string, unknown> = {}) {
  let status = 0;
  let out = "";
  const req = { method, headers: { authorization: `Bearer ${key}` } } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead: (s: number) => void (status = s),
    end: (b: string) => void (out = b),
  } as unknown as ServerResponse;
  await router.handle(req, res, new URL(`http://x/api/desk${path}`), ctx, async () => body);
  return { status, body: JSON.parse(out) as Record<string, unknown> };
}

test("chat routes: history from the store, model switch and new conversation through the brain", async () => {
  const dir = tmp();
  const store = new Store(dir);
  const jarvis = new Jarvis(config(dir), store);
  const bus = new EventBus();
  const brain = new Brain({ claudeBin: "/bin/false", dataDir: dir, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], defaultModel: "claude-sonnet-5-5", internalUrl: "http://127.0.0.1:1", internalToken: "t", warm: false }, store);
  const ctx: DeskContext = { jarvis, bus, devices: new DeviceStore(dir), hub: new SseHub(bus), rpc: new DeskRpc(bus), brain };
  const router = new DeskRouter(chatRoutes);
  const { key } = await ctx.devices.pair("Mac");
  for (const m of state().messages) store.addBrainMessage(m);

  const history = await call(router, ctx, key, "GET", "/chat/history?limit=3");
  assert.equal(history.status, 200);
  const page = history.body as unknown as ChatHistoryResponse;
  assert.equal(page.messages.length, 3);
  assert.equal(page.hasMore, true);
  assert.equal(page.model, "claude-sonnet-5-5");
  assert.deepEqual(page.models, ["claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.equal((await call(router, ctx, key, "GET", "/chat/history?before=yesterday")).status, 400);

  assert.deepEqual((await call(router, ctx, key, "POST", "/chat/model", { model: "claude-haiku-5-5" })).body, { model: "claude-haiku-5-5" });
  assert.equal(brain.model, "claude-haiku-5-5");
  assert.equal((await call(router, ctx, key, "POST", "/chat/model", { model: "gpt" })).status, 400);

  assert.deepEqual((await call(router, ctx, key, "POST", "/chat/reset")).body, { ok: true });
  assert.equal(((await call(router, ctx, key, "GET", "/chat/history")).body as unknown as ChatHistoryResponse).messages.length, 0, "the view starts empty after New conversation");

  const noBrain = { ...ctx, brain: undefined };
  assert.equal((await call(router, noBrain, key, "GET", "/chat/history")).status, 503);
  ctx.hub.close();
});
