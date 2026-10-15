import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT_RPC, type DeskEvent } from "@jarvis/shared";
import { systemPrompt } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { DeskRpc } from "../src/desk/rpc.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import layout from "../src/tools/layout.js";

/** A server with a Desk that answers layout rpcs with `reply` (or nothing, when it's undefined). */
function context(clients: number, reply?: (payload: unknown) => { ok: true; result: unknown } | { ok: false; error: string }) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-layout-"));
  const bus = new EventBus();
  const rpc = new DeskRpc(bus, 200);
  const events: DeskEvent[] = [];
  bus.subscribe((e) => {
    events.push(e);
    if (e.type === "rpc" && reply) setImmediate(() => rpc.answer(e.id, reply(e.payload)));
  });
  const jarvis = new Jarvis({ dataDir: dir, brainConnectors: [] } as unknown as Config, new Store(dir));
  const desk = { bus, rpc, hub: { clientCount: clients } } as unknown as DeskContext;
  return { ctx: { jarvis, config: jarvis.config, desk }, events };
}

const tool = layout.tools.find((t) => t.name === "apply_layout")!;

test("apply_layout sends a layout.apply rpc to the Desk and reports what it did", async () => {
  const { ctx, events } = context(1, (p) => ({
    ok: true,
    result: { name: "Work mode", windows: ["sessions", "today", "chat", "todo"], asked: p },
  }));
  assert.equal(await tool.handler({ name: "work mode" }, ctx), "Applied Work mode: sessions, today, chat, todo open.");
  const sent = events[0];
  assert.ok(sent.type === "rpc" && sent.kind === LAYOUT_RPC);
  assert.deepEqual(sent.payload, { name: "work mode" });

  const focus = context(1, () => ({ ok: true, result: { name: "Focus", windows: [] } }));
  assert.match(await tool.handler({ name: "focus" }, focus.ctx), /every window closed, just the orb/);
});

test("the Desk's error (an unknown layout) reaches the model; a silent Desk times out", async () => {
  const { ctx } = context(1, () => ({ ok: false, error: 'There\'s no layout called "gaming". Layouts: Work mode, Focus.' }));
  await assert.rejects(tool.handler({ name: "gaming" }, ctx), /Layouts: Work mode, Focus/);
  await assert.rejects(tool.handler({ name: "  " }, ctx), /Which layout/);
  const silent = context(1);
  await assert.rejects(tool.handler({ name: "Work mode" }, silent.ctx), /didn't answer/);
});

test("with no Desk connected it says so and sends nothing", async () => {
  const { ctx, events } = context(0, () => ({ ok: true, result: {} }));
  assert.match(await tool.handler({ name: "Work mode" }, ctx), /No screen connected/);
  assert.equal(events.length, 0);
});

test("apply_layout is registered and its hint is in the system prompt", async () => {
  const { ctx } = context(0);
  const registry = await ToolRegistry.discover();
  assert.ok(registry.has("apply_layout"));
  assert.match(systemPrompt(await registry.brainSetup(ctx)), /call apply_layout/);
});
