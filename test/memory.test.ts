import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent } from "@jarvis/shared";
import { Brain, systemPrompt } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { looksSecret, MAX_PROMPT_CHARS, MemoryService, useMemoryService } from "../src/memory.js";
import { NotionApi, notionIdsFile } from "../src/notionWrite.js";
import { setupNotion } from "../src/setupNotion.js";
import { Store } from "../src/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import memoryGroup from "../src/tools/memory.js";
import { fakeNotion } from "./helpers/fakeNotion.js";

type Json = Record<string, unknown>;
const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-memory-"));

async function setup() {
  const dir = tmp();
  const notion = fakeNotion();
  const ids = await setupNotion(new NotionApi("secret", notion.fetchImpl), notion.PARENT, notionIdsFile(dir));
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const svc = new MemoryService(dir, "secret", bus, notion.fetchImpl);
  /** The Memory page as "type: text" lines, in order. */
  const page = () =>
    (notion.children.get(ids.memoryPageId!) ?? []).map((id) => {
      const b = notion.objects.get(id)!;
      const text = ((((b[String(b.type)] as Json).rich_text as Json[]) ?? [])[0]?.text as Json | undefined)?.content;
      return `${b.type}: ${text}`;
    });
  return { dir, notion, ids, bus, events, svc, page };
}

test("remember adds a bullet under the right heading (made if missing); forget removes it; recall matches", async () => {
  const s = await setup();
  await s.svc.remember("His sister is called Emma", "People");
  await s.svc.remember("Prefers short answers", "Preferences");
  await s.svc.remember("His brother is called Tom", "People");
  await s.svc.remember("his sister is called emma", "People"); // a duplicate is not added twice
  assert.deepEqual(s.page(), [
    "heading_2: People",
    "bulleted_list_item: His sister is called Emma",
    "bulleted_list_item: His brother is called Tom",
    "heading_2: Preferences",
    "bulleted_list_item: Prefers short answers",
  ]);
  assert.equal(s.events.filter((e) => e.type === "memory.changed").length, 3);

  assert.deepEqual((await s.svc.recall("sister")).map((f) => f.text), ["His sister is called Emma"]);
  assert.deepEqual((await s.svc.recall("what's my sister called")).map((f) => f.text)[0], "His sister is called Emma");
  assert.deepEqual((await s.svc.recall("people")).length, 2, "the heading counts as context");
  assert.deepEqual(await s.svc.recall("dentist"), []);

  await assert.rejects(s.svc.forget("called"), /matches 2 memories/);
  const gone = await s.svc.forget("brother");
  assert.equal(gone.text, "His brother is called Tom");
  assert.ok(!s.page().includes("bulleted_list_item: His brother is called Tom"));
  const emma = (await s.svc.recall("Emma"))[0];
  await s.svc.forget(emma.id);
  assert.deepEqual(await s.svc.recall("Emma"), []);
});

test("secrets are refused", async () => {
  for (const secret of ["My password is hunter2", "the wifi pin: 4471", "API key = sk-abc123def456ghi789", "token ghp_aaaaBBBBccccDDDD1234", "use 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c"]) {
    assert.ok(looksSecret(secret), secret);
  }
  for (const fine of ["His sister is called Emma", "Prefers British spelling", "Works on JARVIS Desk and ShapeMint", "Likes the token-based design system"]) {
    assert.ok(!looksSecret(fine), fine);
  }
  const s = await setup();
  await assert.rejects(s.svc.remember("My gmail password is hunter2"), /don't store secrets/);
  assert.deepEqual(s.page(), []);
});

test("the system prompt carries the memory; a write restarts the warm brain at its next idle moment", async (t) => {
  const s = await setup();
  await s.svc.remember("His sister is called Emma", "People");
  const jarvis = new Jarvis({ dataDir: s.dir, notionToken: "secret", brainConnectors: [] } as unknown as Config, new Store(s.dir));
  useMemoryService(jarvis, s.svc);
  const ctx = { jarvis, config: jarvis.config, desk: { bus: s.bus } } as never;
  const prompt = systemPrompt(await (await ToolRegistry.discover()).brainSetup(ctx));
  assert.match(prompt, /What you remember about Matthew[\s\S]*## People\n- His sister is called Emma/);
  assert.match(prompt, /never store passwords/i);

  // A warm brain (fake stream-json CLI): a memory write while idle stops the process; the next message starts a new one.
  const bin = join(s.dir, "claude-stream");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(join(s.dir, "spawns"))}, "x");
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: "ok", usage: {} }) + "\\n"), 150);
});
`,
  );
  chmodSync(bin, 0o755);
  const brain = new Brain({ claudeBin: bin, dataDir: s.dir, models: ["m"], defaultModel: "m", internalUrl: "http://127.0.0.1:1", internalToken: "t", bus: s.bus }, jarvis.store);
  t.after(() => brain.stop());
  await brain.chat("hi", "telegram");
  await brain.chat("again", "telegram");
  assert.equal(brain.spawns, 1);
  await s.svc.remember("Lives in London", "About Matthew");
  await brain.chat("after an idle write", "telegram");
  assert.equal(brain.spawns, 2, "restarted to pick up the new memory");

  // A write during a turn waits for the turn to finish (the reply still arrives).
  const turn = brain.chat("long one", "telegram");
  await new Promise((r) => setTimeout(r, 50));
  await s.svc.remember("Drinks flat whites", "Preferences");
  assert.equal((await turn).reply, "ok", "not killed mid-turn");
  await brain.chat("next", "telegram");
  assert.equal(brain.spawns, 3);
});

test("Matthew's own edits in Notion are picked up by poll(); long pages keep the newest facts", async () => {
  const s = await setup();
  await s.svc.remember("Old fact", "Other");
  await s.svc.promptText(); // caches the page
  assert.equal(await s.svc.poll(), false, "no edit yet");
  // He edits the page in Notion: a new bullet appears and last_edited_time moves.
  await new NotionApi("secret", s.notion.fetchImpl).call("PATCH", `/blocks/${s.ids.memoryPageId}/children`, {
    children: [{ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "Added by hand in Notion" } }] } }],
  });
  const before = s.events.length;
  assert.equal(await s.svc.poll(), true);
  assert.equal(s.events[before]?.type, "memory.changed");
  assert.match((await s.svc.promptText())!, /Added by hand in Notion/);

  const big = await setup();
  for (let i = 0; i < 60; i++) await big.svc.remember(`Fact number ${i} ${"x".repeat(80)}`, "Other");
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => void warnings.push(m);
  try {
    const text = (await big.svc.promptText())!;
    assert.ok(text.length <= MAX_PROMPT_CHARS);
    assert.match(text, /Fact number 59 /, "the newest survive");
    assert.doesNotMatch(text, /Fact number 0 /, "the oldest go first");
    assert.match(warnings[0], /over 4000 characters/);
  } finally {
    console.warn = warn;
  }
});

test("memory tools", async () => {
  const s = await setup();
  const jarvis = new Jarvis({ dataDir: s.dir, notionToken: "secret" } as unknown as Config, new Store(s.dir));
  useMemoryService(jarvis, s.svc);
  const ctx = { jarvis, config: jarvis.config };
  const tool = (n: string) => memoryGroup.tools.find((t) => t.name === n)!;
  assert.equal(await tool("remember").handler({ fact: "His sister is called Emma", section: "People" }, ctx), "Noted under People: His sister is called Emma");
  assert.match(await tool("recall").handler({ query: "sister" }, ctx), /\[People\] His sister is called Emma \(id \w+\)/);
  assert.equal(await tool("forget").handler({ fact: "sister" }, ctx), "Forgot: His sister is called Emma");
  assert.equal(await tool("recall").handler({ query: "sister" }, ctx), "Nothing in memory matches.");
});
