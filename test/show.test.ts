import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent } from "@jarvis/shared";
import { systemPrompt } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import { ToolRegistry } from "../src/tools/index.js";
import show, { MAX_BODY } from "../src/tools/show.js";

function context(clients: number) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-show-"));
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const jarvis = new Jarvis({ dataDir: dir, brainConnectors: [] } as unknown as Config, new Store(dir));
  const desk = { bus, hub: { clientCount: clients } } as unknown as DeskContext;
  return { ctx: { jarvis, config: jarvis.config, desk }, events };
}

const tool = show.tools.find((t) => t.name === "show_on_screen")!;

test("show_on_screen publishes a card.show with the given fields and truncates long bodies", async () => {
  const { ctx, events } = context(1);
  const result = await tool.handler(
    {
      title: "mk",
      body: "x".repeat(MAX_BODY + 200),
      kind: "session",
      items: [{ label: "MK-74", detail: "in review" }, { label: "MK-75" }],
      link: { label: "Open session", url: "https://claude.ai/code/session_1" },
    },
    ctx,
  );
  assert.match(result, /^Shown on screen/);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, "card.show");
  if (event.type !== "card.show") return;
  const { card } = event;
  assert.equal(card.title, "mk");
  assert.equal(card.kind, "session");
  assert.equal(card.body.length, MAX_BODY);
  assert.ok(card.body.endsWith("…"));
  assert.deepEqual(card.items, [{ label: "MK-74", detail: "in review" }, { label: "MK-75" }]);
  assert.deepEqual(card.link, { label: "Open session", url: "https://claude.ai/code/session_1" });
  assert.match(card.id, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(card.createdAt));

  await tool.handler({ title: "t", body: "short", kind: "nonsense" }, ctx);
  const second = events[1];
  assert.ok(second.type === "card.show" && second.card.kind === "text" && second.card.body === "short" && !second.card.items);
});

test("with no Desk connected the tool says so and publishes nothing", async () => {
  const { ctx, events } = context(0);
  assert.match(await tool.handler({ title: "t", body: "b" }, ctx), /No screen connected/);
  assert.equal(events.length, 0);
  const { desk: _desk, ...withoutDesk } = context(1).ctx;
  assert.match(await tool.handler({ title: "t", body: "b" }, withoutDesk), /No screen connected/);
});

test("the show hint is in the assembled system prompt", async () => {
  const { ctx } = context(0);
  const setup = await (await ToolRegistry.discover()).brainSetup(ctx);
  assert.match(systemPrompt(setup), /use show_on_screen/);
});
