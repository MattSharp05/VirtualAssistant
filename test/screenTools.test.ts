import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLIPBOARD_MAX_CHARS, type DeskEvent, type RpcAnswer } from "@jarvis/shared";
import { systemPrompt } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import { DeskRpc } from "../src/desk/rpc.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import screen, { NOT_CONNECTED } from "../src/tools/screen.js";
import { UploadStore } from "../src/uploads.js";

type Rpc = Extract<DeskEvent, { type: "rpc" }>;

/** A fake Desk on the live stream: answers each rpc with `answer` (as POST /rpc/:id would). */
function context(clients: number, answer: (e: Rpc, uploads: UploadStore) => RpcAnswer) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-screen-"));
  const uploads = new UploadStore(dir);
  const bus = new EventBus();
  const rpc = new DeskRpc(bus, 1000);
  const asked: Rpc[] = [];
  bus.subscribe((e) => {
    if (e.type !== "rpc") return;
    asked.push(e);
    setImmediate(() => rpc.answer(e.id, answer(e, uploads)));
  });
  const jarvis = new Jarvis({ dataDir: dir, brainConnectors: [] } as unknown as Config, new Store(dir));
  const desk = { bus, rpc, hub: { clientCount: clients } } as unknown as DeskContext;
  return { ctx: { jarvis, config: jarvis.config, desk }, asked };
}

const tool = (name: string) => screen.tools.find((t) => t.name === name)!;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

test("look_at_screen asks the Mac for screen.capture and returns the upload's path to Read", async () => {
  let saved = "";
  const { ctx, asked } = context(1, (_e, uploads) => {
    const upload = uploads.save("screen.jpg", png);
    saved = upload.path;
    return { ok: true, result: { upload, width: 1512, height: 982 } };
  });
  const out = await tool("look_at_screen").handler({}, ctx);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "screen.capture");
  assert.deepEqual(asked[0].payload, {});
  assert.equal(out, `Took a screenshot of Matthew's screen (1512×982). Read ${saved} to see it.`);
});

test("only uploads the server holds are handed to Read, never a path the Mac makes up", async () => {
  const { ctx } = context(1, () => ({ ok: true, result: { upload: { id: "0123456789ab", path: "/etc/passwd", name: "passwd.png" }, width: 1, height: 1 } }));
  await assert.rejects(tool("look_at_screen").handler({}, ctx), /upload didn't arrive/);
  const bad = context(1, () => ({ ok: true, result: { upload: { id: "../../etc", path: "/etc/passwd", name: "x.png" } } }));
  await assert.rejects(tool("look_at_screen").handler({}, bad.ctx), /upload didn't arrive/);
});

test("get_clipboard returns the text, cut at 20k characters", async () => {
  const short = context(1, () => ({ ok: true, result: { kind: "text", text: "teh quick brown fox", truncated: false } }));
  assert.equal(await tool("get_clipboard").handler({}, short.ctx), "The clipboard holds this text:\n\nteh quick brown fox");
  assert.equal(short.asked[0].kind, "clipboard.read");
  const long = context(1, () => ({ ok: true, result: { kind: "text", text: "a".repeat(CLIPBOARD_MAX_CHARS + 50), truncated: true } }));
  const out = await tool("get_clipboard").handler({}, long.ctx);
  assert.equal(out.match(/a{100,}/)![0].length, CLIPBOARD_MAX_CHARS);
  assert.match(out, /Only the first 20,000 characters are shown/);
});

test("get_clipboard with an image returns its upload path; empty says so", async () => {
  let saved = "";
  const image = context(1, (_e, uploads) => {
    const upload = uploads.save("clipboard.png", png);
    saved = upload.path;
    return { ok: true, result: { kind: "image", upload } };
  });
  assert.equal(await tool("get_clipboard").handler({}, image.ctx), `The clipboard holds an image. Read ${saved} to see it.`);
  const empty = context(1, () => ({ ok: true, result: { kind: "empty" } }));
  assert.match(await tool("get_clipboard").handler({}, empty.ctx), /clipboard is empty/);
});

test("the Mac's refusals (e.g. no Screen Recording permission) reach the brain as tool errors", async () => {
  const { ctx } = context(1, () => ({ ok: false, error: "macOS hasn't allowed JARVIS Desk to record the screen." }));
  await assert.rejects(tool("look_at_screen").handler({}, ctx), /record the screen/);
});

test("with no Desk connected both tools say the Mac isn't connected and ask nothing", async () => {
  const { ctx, asked } = context(0, () => ({ ok: true, result: {} }));
  await assert.rejects(tool("look_at_screen").handler({}, ctx), { message: NOT_CONNECTED });
  await assert.rejects(tool("get_clipboard").handler({}, ctx), /your Mac isn't connected/i);
  const { desk: _desk, ...withoutDesk } = ctx;
  await assert.rejects(tool("look_at_screen").handler({}, withoutDesk), /Mac isn't connected/);
  assert.equal(asked.length, 0);
});

test("the prompt hint restricts both tools to explicit requests", async () => {
  const { ctx } = context(0, () => ({ ok: true, result: {} }));
  const registry = await ToolRegistry.discover();
  assert.ok(registry.has("look_at_screen") && registry.has("get_clipboard"));
  const prompt = systemPrompt(await registry.brainSetup(ctx));
  assert.match(prompt, /look_at_screen or get_clipboard ONLY when he explicitly asks/);
  assert.match(prompt, /never on your own/);
});
