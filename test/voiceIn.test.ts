import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Brain } from "../src/brain/index.js";
import { createBot } from "../src/bot.js";
import type { Config } from "../src/config.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { cleanTranscript, transcribe } from "../src/voice/stt.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-voice-"));

/** Fake ffmpeg (copies input → the last argument) and whisper-cli (prints a canned transcript, or fails). */
function fakes(dir: string, whisperOut: string | "fail") {
  const ffmpeg = join(dir, "ffmpeg");
  writeFileSync(ffmpeg, `#!/bin/sh\nfor a; do last="$a"; done\nwhile [ "$1" != "-i" ]; do shift; done\ncp "$2" "$last"\n`);
  const whisper = join(dir, "whisper-cli");
  writeFileSync(
    whisper,
    whisperOut === "fail" ? `#!/bin/sh\necho "error: failed to read model" >&2\nexit 2\n` : `#!/bin/sh\nprintf '%s\\n' "${whisperOut}"\n`,
  );
  chmodSync(ffmpeg, 0o755);
  chmodSync(whisper, 0o755);
  return { ffmpegBin: ffmpeg, whisperBin: whisper, model: "/nowhere/model.bin" };
}

test("stt: ffmpeg → whisper → clean text", async () => {
  const dir = tmp();
  const ogg = join(dir, "note.ogg");
  writeFileSync(ogg, "OggS fake");
  const t = await transcribe(ogg, fakes(dir, " [BLANK_AUDIO] what did I miss on Slack? (music) "));
  assert.equal(t.text, "what did I miss on Slack?");
  assert.ok(t.ms >= 0);
  assert.equal(cleanTranscript("[00:00.000 --> 00:02.000]  hi there\n"), "hi there");
  await assert.rejects(transcribe(ogg, fakes(dir, "fail")), /whisper-cli failed: error: failed to read model/);
});

function telegramHarness(dir: string, whisperOut: string | "fail") {
  const config = { dataDir: dir } as unknown as Config;
  const jarvis = new Jarvis(config, new Store(dir));
  const asked: string[] = [];
  const brain = {
    model: "claude-sonnet-5-5",
    models: ["claude-sonnet-5-5"],
    chat: async (text: string) => {
      asked.push(text);
      return { messageId: "m1", reply: "Priya asked for a review.", metrics: { ms: 900, model: "claude-sonnet-5-5", inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, turns: 1 } };
    },
  } as unknown as Brain;
  const stt = fakes(dir, whisperOut);
  const bot = createBot("123:fake", 42, jarvis, brain, {
    download: async () => new TextEncoder().encode("OggS fake voice"),
    transcribe: (path) => transcribe(path, stt),
  });
  bot.botInfo = { id: 1, is_bot: true, first_name: "JARVIS", username: "jarvis_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
  const sent: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const result = method === "getFile" ? { file_id: "v1", file_unique_id: "u1", file_path: "voice/file_1.oga" } : method === "sendMessage" ? { message_id: sent.length, date: 0, chat: { id: 42, type: "private" } } : true;
    return { ok: true, result } as never;
  });
  const voiceUpdate = {
    update_id: 1,
    message: { message_id: 7, date: 1_760_000_000, chat: { id: 42, type: "private", first_name: "Matthew" }, from: { id: 42, is_bot: false, first_name: "Matthew" }, voice: { file_id: "v1", file_unique_id: "u1", duration: 3, mime_type: "audio/ogg" } },
  };
  const texts = () => sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText").map((s) => String(s.payload.text));
  return { bot, asked, sent, texts, voiceUpdate };
}

test("a voice note is echoed in italics, then handled like typed text", async () => {
  const h = telegramHarness(tmp(), "what did I miss on Slack?");
  await h.bot.handleUpdate(h.voiceUpdate as never);
  assert.deepEqual(h.asked, ["what did I miss on Slack?"], "the brain got the transcript");
  const echo = h.sent.find((s) => s.method === "sendMessage")!;
  assert.equal(echo.payload.text, "🎙 <i>what did I miss on Slack?</i>");
  assert.equal(echo.payload.parse_mode, "HTML");
  assert.match(h.texts().at(-1)!, /^Priya asked for a review\.\n\n⏱ 0\.9s/);
});

test("a whisper failure says so and doesn't crash or reach the brain", async () => {
  const h = telegramHarness(tmp(), "fail");
  await h.bot.handleUpdate(h.voiceUpdate as never);
  assert.deepEqual(h.asked, []);
  assert.deepEqual(h.texts(), ["I couldn't transcribe that. Try again, or type it?"]);
});
