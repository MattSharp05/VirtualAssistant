import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DeskEvent } from "@jarvis/shared";
import { Brain } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Notifier } from "../src/notify.js";
import { JsonFile } from "../src/storage.js";
import { Store } from "../src/store.js";
import { ToolRegistry, type ToolGroup } from "../src/tools/index.js";
import { schema, str } from "../src/tools/types.js";
import { createDashboard } from "../src/web.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-modules-"));

function config(dataDir: string): Config {
  return {
    telegramBotToken: undefined, allowedChatId: undefined, routineId: undefined, routineToken: undefined,
    dataDir, claudeBin: "/bin/false", dashboardPort: 0, dashboardPassword: undefined, reportSecret: undefined,
    reportsPort: 0, notionToken: undefined, brainModels: ["claude-haiku-5-5"], brainModel: "claude-haiku-5-5", brainWarm: false, brainConnectors: [],
  };
}

const echoGroup: ToolGroup = {
  name: "echo",
  promptHint: "- Use echo_back when Matthew says ECHO.",
  cli: { allowedTools: ["mcp__claude_ai_Fake__read"], extraArgs: ["--fake-flag"] },
  tools: [
    {
      name: "echo_back",
      description: "Echoes its input",
      inputSchema: schema({ text: str("What to echo") }, ["text"]),
      handler: async (a) => `echo: ${String(a.text)}`,
    },
  ],
};

test("a registered tool group is listed and callable through MCP, and shapes the brain's prompt and CLI args", async () => {
  const dir = tmp();
  const jarvis = new Jarvis(config(dir), new Store(dir));
  const registry = new ToolRegistry([echoGroup]);
  const server = createDashboard(jarvis, { registry, toolContext: { jarvis, config: jarvis.config }, internalToken: "itok" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/mcp.js", import.meta.url))], {
    env: { ...process.env, JARVIS_INTERNAL_URL: base, JARVIS_INTERNAL_TOKEN: "itok" },
  });
  const replies: Record<string, unknown>[] = [];
  createInterface({ input: child.stdout }).on("line", (l) => replies.push(JSON.parse(l)));
  const next = () =>
    new Promise<Record<string, unknown>>((resolve) => {
      const tick = () => (replies.length ? resolve(replies.shift()!) : setTimeout(tick, 10));
      tick();
    });
  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
  try {
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = ((await next()).result as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.deepEqual(tools, ["echo_back"]);
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo_back", arguments: { text: "hi" } } });
    assert.equal(((await next()).result as { content: { text: string }[] }).content[0].text, "echo: hi");
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
    const unknown = (await next()).result as { isError: boolean; content: { text: string }[] };
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Unknown tool nope/);
  } finally {
    child.kill();
    server.closeAllConnections();
    server.close();
  }

  // The brain's command line gets the group's hint, allowed tools and extra args.
  const log = join(dir, "argv.log");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s ' "$(printf '%s' "$a" | tr '\\n' ' ')"; done >> ${log}; echo >> ${log}\ncat >/dev/null\necho '{"type":"result","result":"ok","usage":{}}'\n`, { mode: 0o755 });
  const brain = new Brain(
    { claudeBin: bin, dataDir: dir, models: ["claude-haiku-5-5"], defaultModel: "claude-haiku-5-5", internalUrl: base, internalToken: "t", warm: false, setup: () => registry.brainSetup({ jarvis, config: jarvis.config }) },
    jarvis.store,
  );
  await brain.chat("hello", "telegram");
  const call = readFileSync(log, "utf8");
  assert.match(call, /Use echo_back when Matthew says ECHO/);
  assert.match(call, /--allowedTools mcp__jarvis,mcp__claude_ai_Fake__read/);
  assert.match(call, /--fake-flag/);
});

test("duplicate tool names across groups are refused", () => {
  assert.throws(() => new ToolRegistry([echoGroup, { ...echoGroup, name: "echo2" }]), /Duplicate tool name echo_back/);
});

test("discovery finds the built-in groups and skips helper modules", async () => {
  const registry = await ToolRegistry.discover();
  const names = registry.groups.map((g) => g.name).sort();
  assert.deepEqual(names, ["connectors", "notion", "sessions", "show", "tasks"]);
});

test("JsonFile keeps the previous file when a write dies before the rename, and serialises writes", async () => {
  const dir = tmp();
  const file = new JsonFile(dir, "things", { n: 0 });
  await file.update((v) => ({ ...v, n: 1 }));
  assert.equal(JSON.parse(readFileSync(file.path, "utf8")).n, 1);

  // Crash after writing the temp file but before rename: the real file must still hold n=1.
  class Crashing extends JsonFile<{ n: number }> {
    protected override write(text: string): void {
      writeFileSync(`${this.path}.tmp`, text);
      throw new Error("power cut");
    }
  }
  const crashing = new Crashing(dir, "things", { n: 0 });
  await crashing.update((v) => ({ ...v, n: 2 }));
  assert.equal(JSON.parse(readFileSync(file.path, "utf8")).n, 1);

  // Many concurrent updates all land, in order.
  const counter = new JsonFile(dir, "counter", { n: 0 });
  await Promise.all(Array.from({ length: 20 }, () => counter.update((v) => ({ n: v.n + 1 }))));
  assert.equal(JSON.parse(readFileSync(counter.path, "utf8")).n, 20);
  assert.equal(new JsonFile(dir, "counter", { n: 0 }).get().n, 20);
});

test("the event bus reaches every subscriber even when one throws", () => {
  const bus = new EventBus();
  const got: DeskEvent[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((e) => got.push(e));
  const unsubscribe = bus.subscribe((e) => got.push(e));
  bus.publish({ type: "orb.state", state: "thinking" });
  unsubscribe();
  bus.publish({ type: "orb.state", state: "idle" });
  assert.deepEqual(got.map((e) => (e.type === "orb.state" ? e.state : "")), ["thinking", "thinking", "idle"]);
});

test("notify publishes a notice and only sends to Telegram when asked", async () => {
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const sent: string[] = [];
  const notifier = new Notifier(bus);
  notifier.attachTelegram(async (t) => {
    sent.push(t);
  });
  await notifier.notify({ title: "mk is blocked", body: "MK-81 needs a decision", level: "alert", telegram: true });
  await notifier.notify({ title: "quiet" });
  assert.equal(events.length, 2);
  assert.deepEqual(sent, ["⛔ mk is blocked\nMK-81 needs a decision"]);
});
