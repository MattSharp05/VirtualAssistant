import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Brain } from "../src/brain/index.js";
import { createBot } from "../src/bot.js";
import type { Config } from "../src/config.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { MAX_SPOKEN_CHARS, speakable, synthesize } from "../src/voice/tts.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-tts-"));

/**
 * Fake piper (saves its stdin and args, writes a "WAV" to --output_file, or fails) and ffmpeg
 * (saves its args, writes an "OGG" to the last argument).
 */
function fakes(dir: string, piper: "ok" | "fail" = "ok") {
  const piperBin = join(dir, "piper");
  writeFileSync(
    piperBin,
    piper === "fail"
      ? `#!/bin/sh\necho "Unable to load model" >&2\nexit 1\n`
      : `#!/bin/sh\necho "$@" > "${dir}/piper.args"\ncat > "${dir}/piper.stdin"\nwhile [ "$1" != "--output_file" ]; do shift; done\nprintf 'RIFF fake wav' > "$2"\n`,
  );
  const ffmpegBin = join(dir, "ffmpeg");
  writeFileSync(ffmpegBin, `#!/bin/sh\necho "$@" > "${dir}/ffmpeg.args"\nfor a; do last="$a"; done\nprintf 'OggS fake opus' > "$last"\n`);
  chmodSync(piperBin, 0o755);
  chmodSync(ffmpegBin, 0o755);
  return { piperBin, ffmpegBin, model: "/nowhere/en_GB-alan-medium.onnx" };
}

test("speakable: markdown, links, code and emoji are removed", () => {
  const reply = [
    "## Today",
    "You have **three** meetings, _all_ on [Google Meet](https://meet.google.com/abc-defg-hij):",
    "- 10:00 Standup with `mk`",
    "- 14:00 Review — see https://github.com/MattSharp05/VirtualAssistant/pull/32 ✅",
    "1. Lunch with Emma 🍝",
    "```",
    "npm test",
    "```",
    "> Reminder: snake_case_names stay intact.",
  ].join("\n");
  assert.equal(
    speakable(reply),
    "Today. You have three meetings, all on Google Meet: 10:00 Standup with mk. 14:00 Review — see. Lunch with Emma. Reminder: snake_case_names stay intact.",
  );
  assert.equal(speakable("Check <https://example.com> or www.example.com/page now."), "Check or now.");
  assert.equal(speakable("```\nonly code\n```"), "");
});

test("speakable: long replies are capped at a sentence end", () => {
  const sentence = "This is one sentence of a long reply. ";
  const spoken = speakable(sentence.repeat(60));
  assert.ok(spoken.length <= MAX_SPOKEN_CHARS, `${spoken.length} chars`);
  assert.ok(spoken.length > MAX_SPOKEN_CHARS - sentence.length);
  assert.match(spoken, /reply\.$/);
  // No sentence break to cut at: cut at a word, with an ellipsis.
  const words = speakable("word ".repeat(400));
  assert.ok(words.length <= MAX_SPOKEN_CHARS + 1);
  assert.match(words, /word…$/);
});

test("tts: speakable text → piper → ffmpeg OGG/Opus 48 kHz mono", async () => {
  const dir = tmp();
  const ogg = await synthesize("**Good evening**, sir. Details: https://example.com", fakes(dir));
  assert.equal(ogg.toString(), "OggS fake opus");
  assert.equal(readFileSync(join(dir, "piper.stdin"), "utf8"), "Good evening, sir. Details:");
  assert.match(readFileSync(join(dir, "piper.args"), "utf8"), /^--model \/nowhere\/en_GB-alan-medium\.onnx --output_file \S+\.wav/);
  assert.match(readFileSync(join(dir, "ffmpeg.args"), "utf8"), /-ar 48000 -ac 1 -c:a libopus .*\.ogg$/m);
  await assert.rejects(synthesize("hello", fakes(tmp(), "fail")), /piper failed: Unable to load model/);
  await assert.rejects(synthesize("```\ncode\n```", fakes(tmp())), /nothing to say/);
});

function telegramHarness(dir: string, piper: "ok" | "fail" = "ok") {
  const config = { dataDir: dir } as unknown as Config;
  const store = new Store(dir);
  const jarvis = new Jarvis(config, store);
  const brain = {
    model: "claude-sonnet-5-5",
    models: ["claude-sonnet-5-5"],
    chat: async () => ({
      messageId: "m1",
      reply: "You have **two** meetings today. Agenda: https://example.com/agenda",
      metrics: { ms: 900, model: "claude-sonnet-5-5", inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, turns: 1 },
    }),
  } as unknown as Brain;
  const tts = fakes(dir, piper);
  const spoken: string[] = [];
  const bot = createBot("123:fake", 42, jarvis, brain, {
    download: async () => new TextEncoder().encode("OggS fake voice"),
    transcribe: async () => ({ text: "what's on today?", ms: 5 }),
    speak: async (text) => {
      spoken.push(text);
      return synthesize(text, tts);
    },
  });
  bot.botInfo = { id: 1, is_bot: true, first_name: "JARVIS", username: "jarvis_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
  const sent: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "getFile"
        ? { file_id: "v1", file_unique_id: "u1", file_path: "voice/file_1.oga" }
        : method === "sendMessage" || method === "sendVoice"
          ? { message_id: sent.length, date: 0, chat: { id: 42, type: "private" } }
          : true;
    return { ok: true, result } as never;
  });
  const chat = { id: 42, type: "private", first_name: "Matthew" };
  const from = { id: 42, is_bot: false, first_name: "Matthew" };
  let updateId = 0;
  const message = (extra: Record<string, unknown>) =>
    bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1_760_000_000, chat, from, ...extra } } as never);
  const voiceNote = () => message({ voice: { file_id: "v1", file_unique_id: "u1", duration: 3, mime_type: "audio/ogg" } });
  const text = (t: string) =>
    message({ text: t, ...(t.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: t.split(" ")[0].length }] } : {}) });
  const methods = () => sent.map((s) => s.method).filter((m) => m !== "sendChatAction");
  return { bot, sent, spoken, voiceNote, text, methods };
}

test("a reply to a voice note sends the text, then a voice note of it", async () => {
  const dir = tmp();
  const h = telegramHarness(dir);
  await h.voiceNote();
  // Echo of the transcript, the reply text, then the voice note.
  assert.deepEqual(h.methods(), ["getFile", "sendMessage", "sendMessage", "sendVoice"]);
  assert.match(String(h.sent.filter((s) => s.method === "sendMessage").at(-1)!.payload.text), /^You have \*\*two\*\* meetings/);
  assert.deepEqual(h.spoken, ["You have **two** meetings today. Agenda: https://example.com/agenda"], "the reply, without metrics");
  assert.equal(readFileSync(join(dir, "piper.stdin"), "utf8"), "You have two meetings today. Agenda:");
  const voice = h.sent.find((s) => s.method === "sendVoice")!;
  assert.equal(voice.payload.chat_id, 42);
  assert.ok(voice.payload.voice, "an audio file is attached");
});

test("/voice off: text only; auto: typed messages get text only; on: every reply is spoken", async () => {
  const dir = tmp();
  const h = telegramHarness(dir);
  await h.text("/voice");
  assert.match(String(h.sent.at(-1)!.payload.text), /^Voice replies auto: /);

  await h.text("what's on today?");
  assert.ok(!h.methods().includes("sendVoice"), "auto: no voice for a typed message");

  await h.text("/voice off");
  assert.match(String(h.sent.at(-1)!.payload.text), /^Voice replies off: text replies only\.$/);
  assert.equal(new Store(dir).brain().voiceReplies, "off", "stored in settings");
  await h.voiceNote();
  assert.ok(!h.methods().includes("sendVoice"), "off: no voice even after a voice note");

  await h.text("/voice on");
  await h.text("what's on today?");
  assert.equal(h.methods().at(-1), "sendVoice", "on: typed messages are spoken too");
  assert.equal(h.spoken.length, 1);
});

test("if speech fails, the text reply still stands and nothing else is sent", async () => {
  const h = telegramHarness(tmp(), "fail");
  await h.voiceNote();
  assert.deepEqual(h.methods(), ["getFile", "sendMessage", "sendMessage"]);
  assert.equal(h.spoken.length, 1);
});
