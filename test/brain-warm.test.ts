import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent } from "@jarvis/shared";
import { Brain, type BrainToolEvent } from "../src/brain/index.js";
import chatRoute from "../src/desk/routes/chat.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { LiveReply, hasFirstSentence } from "../src/liveReply.js";
import type { Config } from "../src/config.js";
import { Store } from "../src/store.js";
import { createDashboard } from "../src/web.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-warm-"));

/**
 * A stand-in for `claude -p --input-format stream-json --output-format stream-json`: logs its argv
 * (one JSON line per spawn), then answers each stdin turn with deltas 80 ms apart and a result.
 * "TOOL" in a turn adds a tool call + result; "CRASH" exits mid-turn (only in the first process);
 * "BYE" exits after answering.
 */
function fakeCli(dir: string): { bin: string; spawns: () => string[][] } {
  const log = join(dir, "argv.jsonl");
  const bin = join(dir, "claude-stream");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const spawnNo = fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queue = Promise.resolve();
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  queue = queue.then(async () => {
    const text = JSON.parse(line).message.content;
    out({ type: "system", subtype: "init" });
    if (text.includes("CRASH") && spawnNo === 1) { await sleep(20); process.exit(3); }
    out({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null });
    if (text.includes("TOOL")) {
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__jarvis__overview", input: { project: "mk" } }] }, parent_tool_use_id: null });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "mk: 3/5 merged\\nmore" }] }] }, parent_tool_use_id: null });
      out({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null });
    }
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "subagent noise" } }, parent_tool_use_id: "tu9" });
    for (const word of ["All ", "good. ", "Two ", "builders."]) {
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: word } }, parent_tool_use_id: null });
      await sleep(80);
    }
    out({ type: "rate_limit_event" });
    out({ type: "result", subtype: "success", is_error: false, result: "All good. Two builders.", duration_ms: 1234, num_turns: text.includes("TOOL") ? 2 : 1, total_cost_usd: 0.01, usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 42 } });
    if (text.includes("BYE")) process.exit(0);
  });
});
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    spawns: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[]),
  };
}

function brainFor(dir: string, bin: string, bus?: EventBus): Brain {
  return new Brain(
    { claudeBin: bin, dataDir: dir, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], defaultModel: "claude-sonnet-5-5", internalUrl: "http://127.0.0.1:1", internalToken: "t", bus },
    new Store(dir),
  );
}

const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

test("warm brain: streams deltas before the reply finishes, reuses one process, reports metrics and tools", async (t) => {
  const dir = tmp();
  const { bin, spawns } = fakeCli(dir);
  const bus = new EventBus();
  const events: { at: number; event: DeskEvent }[] = [];
  bus.subscribe((event) => events.push({ at: Date.now(), event }));
  const brain = brainFor(dir, bin, bus);
  t.after(() => brain.stop());
  const tools: BrainToolEvent[] = [];
  brain.onTool((e) => tools.push(e));

  const chunks: string[] = [];
  const first = await brain.chat("what's mk up to? TOOL", "telegram", { onDelta: (c) => chunks.push(c) });
  assert.equal(first.reply, "All good. Two builders.");
  assert.deepEqual(first.metrics, { ms: 1234, model: "claude-sonnet-5-5", inputTokens: 10, cacheReadTokens: 5000, cacheWriteTokens: 100, outputTokens: 42, turns: 2, apiEquivalentUsd: 0.01 });
  assert.equal(chunks.join(""), "All good. Two builders.", "subagent deltas are skipped; no break before the first text");

  const firstDelta = events.find((e) => e.event.type === "brain.delta")!;
  const done = events.find((e) => e.event.type === "brain.done")!;
  assert.ok(done.at - firstDelta.at >= 150, `first delta ${done.at - firstDelta.at}ms before done`);
  assert.equal((done.event as { messageId: string }).messageId, first.messageId);
  assert.deepEqual(
    events.filter((e) => e.event.type === "orb.state").map((e) => (e.event as { state: string }).state),
    ["thinking", "idle"],
  );
  assert.deepEqual(
    tools.map((e) => [e.phase, e.name, e.summary]),
    [
      ["call", "mcp__jarvis__overview", undefined],
      ["result", "mcp__jarvis__overview", "mk: 3/5 merged"],
    ],
  );
  assert.ok(events.some((e) => e.event.type === "brain.tool" && e.event.phase === "result"));

  await brain.chat("and shapemint?", "dashboard");
  assert.equal(spawns().length, 1, "the second message reuses the warm process");
  assert.equal(brain.spawns, 1);
  const argv = spawns()[0];
  assert.equal(flag(argv, "--input-format"), "stream-json");
  assert.equal(flag(argv, "--output-format"), "stream-json");
  assert.ok(argv.includes("--include-partial-messages") && argv.includes("--verbose"));
  assert.equal(flag(argv, "--model"), "claude-sonnet-5-5");
  assert.match(flag(argv, "--session-id")!, /^[0-9a-f-]{36}$/);
  assert.equal(new Store(dir).brain().totals.replies, 2);
});

test("warm brain: model change and reset restart the process; a crash restarts with --resume", async (t) => {
  const dir = tmp();
  const { bin, spawns } = fakeCli(dir);
  const brain = brainFor(dir, bin);
  t.after(() => brain.stop());

  // A crash mid-turn: the turn is retried in a new process that resumes the same conversation.
  await brain.chat("hello", "telegram");
  const sessionId = flag(spawns()[0], "--session-id")!;
  const crashed = await brain.chat("CRASH please", "telegram");
  assert.equal(crashed.reply, "All good. Two builders.");
  assert.equal(spawns().length, 2);
  assert.equal(flag(spawns()[1], "--resume"), sessionId);

  // Exiting between turns: the next message resumes too.
  await brain.chat("BYE", "telegram");
  await brain.chat("still there?", "telegram");
  assert.equal(spawns().length, 3);
  assert.equal(flag(spawns()[2], "--resume"), sessionId);

  brain.setModel("claude-haiku-5-5");
  await brain.chat("now on haiku", "telegram");
  assert.equal(spawns().length, 4);
  assert.equal(flag(spawns()[3], "--model"), "claude-haiku-5-5");
  assert.equal(flag(spawns()[3], "--resume"), sessionId, "a model change keeps the conversation");

  brain.reset();
  await brain.chat("fresh start", "telegram");
  assert.equal(spawns().length, 5);
  const fresh = flag(spawns()[4], "--session-id");
  assert.ok(fresh && fresh !== sessionId, "reset starts a new conversation");
  assert.equal(flag(spawns()[4], "--resume"), undefined);
});

test("Telegram live reply: waits for a first sentence, edits at most once per gap, ends with the footer", async () => {
  assert.equal(hasFirstSentence("Checking"), false);
  assert.equal(hasFirstSentence("Checking now. "), true);
  const calls: { at: number; kind: "send" | "edit"; text: string }[] = [];
  const io = {
    send: async (text: string) => (calls.push({ at: Date.now(), kind: "send", text }), 7),
    edit: async (_id: number, text: string) => void calls.push({ at: Date.now(), kind: "edit", text }),
  };
  assert.equal((new LiveReply(io) as unknown as { minGapMs: number }).minGapMs, 1500, "Telegram default: one edit per 1.5 s");

  const live = new LiveReply(io, 200);
  live.push("Mk is");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0, "nothing sent before the first sentence");
  live.push(" on MK-74. ");
  for (let i = 0; i < 30; i++) {
    live.push(`word${i} `);
    await new Promise((r) => setTimeout(r, 25));
  }
  await live.finish("Mk is on MK-74. All done.\n\n⏱ 1.2s · sonnet");
  assert.equal(calls[0].kind, "send");
  assert.match(calls[0].text, /^Mk is on MK-74\./);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 195, `call ${i} came ${calls[i].at - calls[i - 1].at}ms after the previous one`);
  assert.ok(calls.length >= 3, "the message grew while text arrived");
  assert.equal(calls.at(-1)!.text, "Mk is on MK-74. All done.\n\n⏱ 1.2s · sonnet");
  assert.equal(calls.at(-1)!.kind, "edit");

  // A reply that finishes before its first sentence is a single plain message; long ones continue in new messages.
  const short: string[] = [];
  const quick = new LiveReply({ send: async (t) => (short.push(t), 1), edit: async () => assert.fail("no edit") }, 200);
  quick.push("ok");
  await quick.finish("x".repeat(4500));
  assert.deepEqual(short.map((t) => t.length), [4000, 500]);
});

test("POST /api/desk/chat answers with a message id and the reply arrives as brain.* events", async (t) => {
  const dir = tmp();
  const { bin } = fakeCli(dir);
  const bus = new EventBus();
  const brain = brainFor(dir, bin, bus);
  t.after(() => brain.stop());
  const seen: DeskEvent[] = [];
  const finished = new Promise<void>((resolve) =>
    bus.subscribe((e) => {
      seen.push(e);
      if (e.type === "brain.done") resolve();
    }),
  );
  const ctx = { bus, brain } as unknown as DeskContext;
  const call = (body: Record<string, unknown>) => (chatRoute as { handler: (r: unknown) => unknown }).handler({ body, ctx, params: {} });
  assert.throws(() => call({ text: "  " }), /text is empty/);
  const { messageId } = call({ text: "what's on today?", channel: "desk-voice" }) as { messageId: string };
  await finished;
  assert.deepEqual(seen[0], { type: "brain.start", messageId, channel: "desk-voice", text: "what's on today?" });
  assert.ok(seen.some((e) => e.type === "brain.delta" && e.messageId === messageId));
  assert.ok(seen.some((e) => e.type === "brain.done" && e.messageId === messageId && e.text === "All good. Two builders."));
});

test("the dashboard chat streams NDJSON deltas and then the finished reply", async (t) => {
  const dir = tmp();
  const { bin } = fakeCli(dir);
  const config = {
    telegramBotToken: undefined, allowedChatId: undefined, routineId: undefined, routineToken: undefined,
    dataDir: dir, claudeBin: "/bin/false", dashboardPort: 0, dashboardPassword: undefined, reportSecret: undefined,
    reportsPort: 0, notionToken: undefined, brainModels: ["claude-sonnet-5-5"], brainModel: "claude-sonnet-5-5", brainWarm: true, brainConnectors: [],
  } satisfies Config;
  const store = new Store(dir);
  const brain = new Brain({ claudeBin: bin, dataDir: dir, models: ["claude-sonnet-5-5"], defaultModel: "claude-sonnet-5-5", internalUrl: "http://127.0.0.1:1", internalToken: "t" }, store);
  const server = createDashboard(new Jarvis(config, store), { brain });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    brain.stop();
    server.closeAllConnections();
    server.close();
  });
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/brain/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi", stream: true }),
  });
  assert.match(res.headers.get("content-type") ?? "", /ndjson/);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.slice(0, -1).map((l) => l.delta), ["All ", "good. ", "Two ", "builders."]);
  assert.equal(lines.at(-1).done.reply, "All good. Two builders.");
});
