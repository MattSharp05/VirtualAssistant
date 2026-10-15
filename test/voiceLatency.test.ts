import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { VoiceLatencyTurn } from "@jarvis/shared";
import { Brain } from "../src/brain/index.js";
import chatRoutes from "../src/desk/routes/chat.js";
import type { DeskContext, DeskRoute } from "../src/desk/routes/index.js";
import systemRoutes from "../src/desk/routes/system.js";
import { Store } from "../src/store.js";
import { parseLatencyTurn, percentile, summarizeLatency, VoiceLatencyLog } from "../src/voiceLatency.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-latency-"));

const turn = (audioStart: number | undefined, extra: Partial<VoiceLatencyTurn["stages"]> = {}): VoiceLatencyTurn => ({
  at: "2026-10-15T09:00:00.000Z",
  trigger: "ptt",
  speechMs: 1400,
  stages: { endpoint: 700, transcript: 1000, sent: 1010, firstDelta: 1800, ...extra, ...(audioStart === undefined ? {} : { audioStart }) },
});

const route = (routes: DeskRoute[], path: string) => routes.find((r) => r.method === "POST" && r.path === path)!.handler as (r: unknown) => unknown;

test("percentile is nearest-rank; null for nothing", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([3000], 90), 3000);
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => n * 100);
  assert.equal(percentile(ten, 50), 500);
  assert.equal(percentile(ten, 90), 900);
  assert.equal(percentile([...ten].reverse(), 90), 900, "order doesn't matter");
});

test("summarizeLatency: p50/p90 of the first word over the last 20 turns that had one, stage medians in order", () => {
  const turns = [
    ...Array.from({ length: 5 }, () => turn(9000)), // older than the last 20: ignored
    ...Array.from({ length: 20 }, (_, i) => turn(2000 + i * 100)),
    turn(undefined), // cancelled: no first word, not counted, but it's the last turn
  ];
  const s = summarizeLatency(turns);
  assert.equal(s.turns, 20);
  assert.equal(s.p50, 2900);
  assert.equal(s.p90, 3700);
  assert.deepEqual(s.stages.map((x) => x.stage), ["endpoint", "transcript", "sent", "firstDelta", "audioStart"]);
  assert.equal(s.stages[0].p50, 700);
  assert.equal(s.last?.stages.audioStart, undefined);
  assert.deepEqual(summarizeLatency([]), { turns: 0, p50: null, p90: null, stages: [] });
});

test("parseLatencyTurn keeps known stages as whole ms and refuses a turn without a time or trigger", () => {
  const parsed = parseLatencyTurn({
    at: "2026-10-15T09:00:00Z", trigger: "wake", speechMs: 1200.4, model: "claude-haiku-5-5",
    stages: { transcript: 412.6, audioStart: 2310, bogus: 5, sent: "soon", firstDelta: 1e9 },
  });
  assert.deepEqual(parsed, { at: "2026-10-15T09:00:00Z", trigger: "wake", speechMs: 1200, model: "claude-haiku-5-5", stages: { transcript: 413, audioStart: 2310 } });
  assert.throws(() => parseLatencyTurn({ trigger: "ptt" }), /at must be/);
  assert.throws(() => parseLatencyTurn({ at: "2026-10-15T09:00:00Z", trigger: "typed" }), /trigger/);
});

test("POST /system/latency appends to voice-latency.jsonl; the log keeps the last 200", () => {
  const dir = tmp();
  const ctx = { jarvis: { config: { dataDir: dir } } } as unknown as DeskContext;
  const post = route(systemRoutes, "/system/latency");
  assert.deepEqual(post({ body: turn(2400), ctx, params: {} }), { ok: true });
  assert.throws(() => post({ body: { at: "nope" }, ctx, params: {} }), /at must be/);
  const log = new VoiceLatencyLog(dir);
  assert.equal(log.list().length, 1);
  assert.equal(log.summary().p50, 2400);
  for (let i = 0; i < 300; i++) log.add(turn(i));
  const lines = readFileSync(join(dir, "voice-latency.jsonl"), "utf8").trim().split("\n");
  assert.ok(lines.length <= 300 && lines.length >= 200, `kept ${lines.length}`);
  assert.equal(log.list().at(-1)?.stages.audioStart, 299);
});

/** A `claude` stream-json stand-in that only logs its argv (a prewarm never sends a turn). */
function fakeCli(dir: string): { bin: string; spawns: () => string[][] } {
  const log = join(dir, "argv.jsonl");
  const bin = join(dir, "claude-stream");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Yes." } }, parent_tool_use_id: null });
  out({ type: "result", result: "Yes.", duration_ms: 5, num_turns: 1, usage: {} });
});
`,
  );
  chmodSync(bin, 0o755);
  const spawns = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  return { bin, spawns };
}

const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

test("POST /chat/warm starts the warm brain once; a voice turn's model is used for that turn only", async (t) => {
  const dir = tmp();
  const { bin, spawns } = fakeCli(dir);
  const brain = new Brain(
    { claudeBin: bin, dataDir: dir, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], defaultModel: "claude-sonnet-5-5", internalUrl: "http://127.0.0.1:1", internalToken: "t" },
    new Store(dir),
  );
  t.after(() => brain.stop());
  const ctx = { brain } as unknown as DeskContext;
  const warm = route(chatRoutes, "/chat/warm");
  const chat = route(chatRoutes, "/chat");

  // Two prewarms at once share one process; a third finds it running.
  const [a, b] = await Promise.all([warm({ body: {}, ctx, params: {} }), warm({ body: {}, ctx, params: {} })]);
  assert.deepEqual([a, b].map((r) => (r as { started: boolean }).started).sort(), [false, true]);
  assert.deepEqual(await warm({ body: {}, ctx, params: {} }), { started: false });
  await waitFor(() => spawns().length === 1);
  assert.equal(spawns().length, 1);
  assert.equal(brain.spawns, 1);

  // The first turn reuses the prewarmed process.
  await brain.chat("hello", "desk-voice");
  assert.equal(brain.spawns, 1);

  // A voice turn on Haiku: that turn's process is Haiku and the reply's metrics say so; the chosen model stays.
  assert.throws(() => chat({ body: { text: "hi", channel: "desk-voice", model: "gpt" }, ctx, params: {} }), /Unknown model gpt/);
  const reply = await brain.chat("quick one", "desk-voice", { model: "claude-haiku-5-5" });
  assert.equal(reply.metrics.model, "claude-haiku-5-5");
  assert.equal(brain.model, "claude-sonnet-5-5");
  await waitFor(() => spawns().length === 2);
  assert.equal(flag(spawns()[1], "--model"), "claude-haiku-5-5");
  assert.equal(flag(spawns()[1], "--resume"), flag(spawns()[0], "--session-id"), "the same conversation");

  // Prewarming for Haiku while Haiku is warm: nothing to do. An unknown model is refused.
  assert.deepEqual(await warm({ body: { model: "claude-haiku-5-5" }, ctx, params: {} }), { started: false });
  await assert.rejects(async () => warm({ body: { model: "gpt" }, ctx, params: {} }), /Unknown model/);
});
