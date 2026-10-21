import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InputFile } from "grammy";
import { systemPrompt } from "../src/brain/index.js";
import { createBot, sendTelegramFile } from "../src/bot.js";
import type { Config } from "../src/config.js";
import { Jarvis } from "../src/jarvis.js";
import { notifier } from "../src/notify.js";
import { Store } from "../src/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import sendFile, { NO_TELEGRAM } from "../src/tools/sendFile.js";
import { UploadStore, type Upload } from "../src/uploads.js";

function context() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sendfile-"));
  const jarvis = new Jarvis({ dataDir: dir, brainConnectors: [] } as unknown as Config, new Store(dir));
  const uploads = new UploadStore(dir);
  return { dir, jarvis, uploads, ctx: { jarvis, config: jarvis.config } };
}

const tool = sendFile.tools.find((t) => t.name === "send_file")!;

test("send_file: an unknown upload id is a tool error", async (t) => {
  t.after(() => notifier.attachTelegramFile(undefined));
  const { ctx } = context();
  notifier.attachTelegramFile(async () => assert.fail("nothing should be sent"));
  await assert.rejects(tool.handler({ uploadId: "0123456789ab" }, ctx), /No upload with id 0123456789ab/);
  await assert.rejects(tool.handler({ uploadId: "../../etc/passwd" }, ctx), /No upload with id/);
  await assert.rejects(tool.handler({}, ctx), /No upload with id/);
});

test("send_file: without Telegram it says so instead of throwing", async () => {
  const { ctx, uploads } = context();
  notifier.attachTelegramFile(undefined);
  const upload = uploads.save("shot.png", new Uint8Array([1, 2, 3]));
  assert.equal(await tool.handler({ uploadId: upload.id }, ctx), NO_TELEGRAM);
  assert.match(NO_TELEGRAM, /Telegram isn't connected/);
});

test("send_file: sends the upload and caption through the notifier; a Telegram failure is a tool error", async (t) => {
  t.after(() => notifier.attachTelegramFile(undefined));
  const { ctx, uploads } = context();
  const upload = uploads.save("report.pdf", new TextEncoder().encode("%PDF-1.4"));
  const sent: { upload: Upload; caption?: string }[] = [];
  notifier.attachTelegramFile(async (u, caption) => void sent.push({ upload: u, caption }));
  assert.equal(await tool.handler({ uploadId: upload.id, caption: "Here's the report" }, ctx), "Sent report.pdf to Telegram.");
  assert.deepEqual(sent, [{ upload, caption: "Here's the report" }]);
  await tool.handler({ uploadId: upload.id, caption: "  " }, ctx);
  assert.equal(sent[1].caption, undefined, "a blank caption is dropped");

  notifier.attachTelegramFile(async () => {
    throw new Error("Bad Request: chat not found");
  });
  await assert.rejects(tool.handler({ uploadId: upload.id }, ctx), /Telegram didn't take report\.pdf: Bad Request: chat not found/);
});

test("the send_file hint is in the assembled system prompt", async () => {
  const { ctx } = context();
  const setup = await (await ToolRegistry.discover()).brainSetup(ctx);
  assert.match(systemPrompt(setup), /use send_file/);
});

/** A real grammy Bot whose API calls are recorded instead of reaching Telegram (as in voiceOut.test.ts). */
function telegramHarness(dir: string) {
  const jarvis = new Jarvis({ dataDir: dir } as unknown as Config, new Store(dir));
  const bot = createBot("123:fake", 42, jarvis);
  bot.botInfo = { id: 1, is_bot: true, first_name: "JARVIS", username: "jarvis_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
  const sent: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 42, type: "private" } } } as never;
  });
  return { bot, sent };
}

test("Telegram: images go out with sendPhoto, other files with sendDocument, to the chat with the caption", async () => {
  const { dir, uploads } = context();
  const h = telegramHarness(dir);
  const png = uploads.save("screen.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const jpg = uploads.save("Photo.JPG", new Uint8Array([0xff, 0xd8]));
  const csv = uploads.save("costs.csv", new TextEncoder().encode("a,b\n1,2\n"));

  assert.equal(await sendTelegramFile(h.bot, 42, png, "Your screen"), "photo");
  assert.equal(await sendTelegramFile(h.bot, 42, jpg), "photo");
  assert.equal(await sendTelegramFile(h.bot, 42, csv, "x".repeat(2000)), "document");
  assert.deepEqual(
    h.sent.map((s) => s.method),
    ["sendPhoto", "sendPhoto", "sendDocument"],
  );
  const [photo, plain, doc] = h.sent.map((s) => s.payload);
  assert.equal(photo.chat_id, 42);
  assert.equal(photo.caption, "Your screen");
  assert.ok(photo.photo instanceof InputFile, "the file is attached");
  assert.equal((photo.photo as InputFile).filename, "screen.png");
  assert.equal(plain.caption, undefined);
  assert.equal(doc.chat_id, 42);
  assert.ok(doc.document instanceof InputFile);
  assert.equal((doc.document as InputFile).filename, "costs.csv");
  assert.equal(String(doc.caption).length, 1024, "captions are cut to Telegram's limit");
});

test("Telegram: the send_file tool reaches sendPhoto through the notifier wiring used at startup", async (t) => {
  t.after(() => notifier.attachTelegramFile(undefined));
  const { dir, uploads, ctx } = context();
  const h = telegramHarness(dir);
  // As index.ts wires it.
  notifier.attachTelegramFile(async (upload, caption) => {
    await sendTelegramFile(h.bot, 42, upload, caption);
  });
  const png = uploads.save("clip.png", new Uint8Array([1]));
  assert.equal(await tool.handler({ uploadId: png.id, caption: "From your clipboard" }, ctx), "Sent clip.png to Telegram.");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].method, "sendPhoto");
  assert.equal(h.sent[0].payload.chat_id, 42);
  assert.equal(h.sent[0].payload.caption, "From your clipboard");
});
