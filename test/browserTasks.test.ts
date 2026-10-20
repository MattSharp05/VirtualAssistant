import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BROWSER_NEEDS_APPROVAL,
  BROWSER_NEEDS_MATTHEW,
  BROWSER_TAKEN_OVER,
  type BrowserTaskGrant,
  type BrowserTaskSummary,
  type DeskEvent,
} from "@jarvis/shared";
import { BROWSER_BRAIN_TASK_TOOLS, BROWSER_TURN_MS, browserSetup, createBrowserBrain } from "../src/browser/brain.js";
import { modeFromText, modeRules } from "../src/browser/risk.js";
import { BROWSER_TASK_PROMPT, BrowserTaskRunner, KEEP_DAYS, NOT_CONNECTED, useBrowserTasks, type TaskBrain } from "../src/browser/tasks.js";
import type { Config } from "../src/config.js";
import browserRoutes from "../src/desk/routes/browser.js";
import type { DeskContext, DeskRequest } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import type { BrainMessage } from "../src/store.js";
import { Store } from "../src/store.js";
import browser, { BROWSER_TASK_TOOLS } from "../src/tools/browser.js";
import { ToolRegistry, type ToolContext } from "../src/tools/index.js";

// ── A fake Mac: the browser.* rpc kinds on a checkout page, with the real Mac's guard rules ──

/** The page's refs: 3 = "Check availability", 7 = "Place order" (risky), 9 = the Password field. */
const REFS: Record<number, { role: string; name: string }> = {
  3: { role: "button", name: "Check availability" },
  7: { role: "button", name: "Place order" },
  9: { role: "textbox", name: "Password" },
};

class FakeMac {
  calls: { kind: string; payload: Record<string, unknown> }[] = [];
  connectedNow = true;
  takenOver = false;
  url = "https://shop.example/checkout";

  connected = () => this.connectedNow;

  call = async (kind: string, payload: unknown): Promise<unknown> => {
    const p = (payload ?? {}) as Record<string, unknown>;
    this.calls.push({ kind, payload: p });
    if (kind === "browser.status") return {};
    if (this.takenOver) throw new Error(BROWSER_TAKEN_OVER);
    const page = { url: this.url, title: "Checkout · Shop", change: "page changed" };
    if (kind === "browser.open") return { ...page, url: String(p.url) };
    if (kind === "browser.snapshot") return { ...page, text: '[3] button “Check availability”\n[7] button “Place order”\n[9] textbox “Password”' };
    if (kind === "browser.click" || kind === "browser.type") {
      const el = REFS[Number(p.ref)];
      const task = p.task as BrowserTaskGrant | undefined;
      if (kind === "browser.type" && el?.name === "Password")
        throw new Error(`${BROWSER_NEEDS_MATTHEW}: ‘Password’ asks for a password. Matthew enters it himself (Take over, then Hand back).`);
      if (kind === "browser.click" && el?.name === "Place order" && task?.mode !== "full" && !task?.approval)
        throw new Error(`${BROWSER_NEEDS_APPROVAL}: clicking ‘Place order’ could buy, book, send, post or delete something.`);
      return { ...page, change: "page changed" };
    }
    return page;
  };

  kinds(): string[] {
    return this.calls.filter((c) => c.kind !== "browser.status").map((c) => c.kind);
  }

  statuses(): string[] {
    return this.calls.filter((c) => c.kind === "browser.status").map((c) => String(c.payload.text ?? ""));
  }
}

/** A stand-in browser brain: each turn runs the next scripted step against the real tools. */
class FakeBrain implements TaskBrain {
  turns: string[] = [];
  resets = 0;
  constructor(private readonly script: ((call: Call, message: string) => Promise<void>)[]) {}
  call!: Call;
  reset() {
    this.resets++;
  }
  async chat(text: string): Promise<unknown> {
    this.turns.push(text);
    const step = this.script[this.turns.length - 1];
    if (step) await step(this.call, text);
    return {};
  }
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<string>;

function setup(script: ((call: Call, message: string) => Promise<void>)[], opts: { clients?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-browser-"));
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store = new Store(dir);
  const jarvis = new Jarvis({ dataDir: dir, brainConnectors: [] } as unknown as Config, store);
  const mac = new FakeMac();
  const brain = new FakeBrain(script);
  const telegram: string[] = [];
  const chat: BrainMessage[] = [];
  let tokens = 0;
  const runner = new BrowserTaskRunner({
    dataDir: dir,
    bus,
    brain,
    mac,
    telegram: async (t) => void telegram.push(t),
    chat: { addBrainMessage: (m) => void chat.push(m) },
    token: () => `appr-${++tokens}`,
  });
  useBrowserTasks(jarvis, runner);
  const desk = { bus, hub: { clientCount: opts.clients ?? 1 } } as unknown as DeskContext;
  const ctx: ToolContext = { jarvis, config: jarvis.config, desk };
  const tool = (name: string) => browser.tools.find((t) => t.name === name)!;
  brain.call = (name, args = {}) => tool(name).handler(args, ctx);
  /** Like the MCP server: a thrown tool error is what the model reads. */
  const tryCall: Call = (name, args = {}) => tool(name).handler(args, ctx).catch((err: Error) => `Error: ${err.message}`);
  const route = (method: string, path: string) => browserRoutes.find((r) => r.method === method && r.path === path)!;
  const req = (params: Record<string, string> = {}, body: Record<string, unknown> = {}) =>
    ({ params, body, ctx: { jarvis, bus } as unknown as DeskContext }) as unknown as DeskRequest;
  return { dir, bus, events, runner, mac, brain, telegram, chat, ctx, tool, tryCall, route, req };
}

/** A turn that stays open (the brain still working) until the test lets it end. */
function gate(): { turn: () => Promise<void>; end: () => void } {
  let end = () => {};
  const done = new Promise<void>((r) => (end = r));
  return { turn: () => done, end };
}

/** Lets the runner's loop take its next turn. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const notices = (events: DeskEvent[]) => events.filter((e): e is Extract<DeskEvent, { type: "notice" }> => e.type === "notice");
const cards = (events: DeskEvent[]) => events.filter((e): e is Extract<DeskEvent, { type: "card.show" }> => e.type === "card.show");

// ── Modes ──

test("the mode comes from the request's words: Full for “do it on your own”, else the switch (Normal)", () => {
  for (const text of [
    "Book a table at Lilia for Friday 8pm for 2, do it on your own",
    "Order more coffee pods, full autonomy",
    "Renew the parking permit without asking me",
    "Buy the cheapest one, no need to ask",
    "Cancel my gym membership, you don't need to check with me",
    "Book it yourself",
  ])
    assert.equal(modeFromText(text), "full", text);
  for (const text of ["Book a table at Lilia for Friday 8pm for 2", "Find the cheapest flight to Lisbon in March", "Ask me before you book"])
    assert.equal(modeFromText(text), "normal", text);
  assert.equal(modeFromText("Find flights", "full"), "full");
  assert.equal(modeFromText("Find flights", "normal"), "normal");
  assert.match(modeRules("normal"), /ASK FIRST/);
  assert.match(modeRules("full"), /without asking/);
  assert.match(modeRules("full"), /Still never type a password/);
});

// ── The tool loop ──

test("a task runs the tool loop on its own conversation and comes back with a summary and a card", async () => {
  const t = setup([
    async (call) => {
      await call("browser_open", { url: "https://lilia.example", step: "Opening Lilia" });
      const page = await call("browser_snapshot");
      assert.match(page, /\[3\] button “Check availability”/);
      await call("browser_click", { ref: 3, step: "Checking Friday 8pm" });
      await call("browser_done", {
        summary: "Lilia has 8pm on Friday for 2; I held nothing.",
        card: { title: "Lilia · Friday", items: [{ label: "20:00", detail: "2 people" }] },
      });
    },
  ]);
  const started = t.runner.start({ text: "Check Lilia for Friday 8pm for 2", origin: "telegram" });
  assert.equal(started.mode, "normal");
  assert.equal(started.status, "running");
  await settle();

  assert.equal(t.brain.resets, 1);
  assert.match(t.brain.turns[0], /Task from Matthew:\nCheck Lilia for Friday 8pm for 2/);
  assert.match(t.brain.turns[0], /Mode: NORMAL/);
  assert.deepEqual(t.mac.kinds(), ["browser.open", "browser.snapshot", "browser.click"]);
  assert.ok(t.mac.statuses().includes("Checking Friday 8pm"), "the window's status line shows the step");
  assert.equal(t.mac.statuses().at(-1), "", "and goes back to Ready at the end");
  const click = t.mac.calls.find((c) => c.kind === "browser.click")!;
  assert.deepEqual(click.payload.task, { taskId: started.id, mode: "normal" });

  const done = t.runner.get(started.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.result, "Lilia has 8pm on Friday for 2; I held nothing.");
  assert.deepEqual(
    done.log.map((s) => s.kind),
    ["start", "action", "action", "done"],
  );
  assert.equal(done.log[1].url, "https://lilia.example");
  // Back where it was asked (Telegram) and as a card.
  assert.deepEqual(t.telegram, ["🌐 Lilia has 8pm on Friday for 2; I held nothing."]);
  const [card] = cards(t.events);
  assert.equal(card.card.title, "Lilia · Friday");
  assert.deepEqual(card.card.items, [{ label: "20:00", detail: "2 people" }]);
  assert.ok(t.events.some((e) => e.type === "browser.task" && e.task.status === "done"));
});

test("Normal mode: a “Place order” click produces an approval card first; Approve's token lets it through once", async () => {
  let reply = "";
  const t = setup([
    async (call) => {
      await call("browser_open", { url: "https://shop.example/checkout" });
      reply = await call("browser_click", { ref: 7, step: "Placing the order" }).catch((e: Error) => e.message);
    },
    async (call, message) => {
      const token = /approval "([^"]+)"/.exec(message)![1];
      await call("browser_click", { ref: 7, approval: token, step: "Placing the order" });
      await call("browser_done", { summary: "Ordered: 2 bags of coffee, £18, arriving Tuesday." });
    },
  ]);
  const task = t.runner.start({ text: "Reorder my usual coffee", origin: "browser" });
  await settle();

  assert.match(reply, /needs Matthew's approval, and he's been asked/);
  assert.match(reply, /End your turn now/);
  const waiting = t.runner.get(task.id)!;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.question?.kind, "approval");
  assert.equal(waiting.question?.text, "OK to click ‘Place order’ on shop.example? (Placing the order)");
  const [ask] = notices(t.events);
  assert.equal(ask.title, "JARVIS needs your OK");
  assert.deepEqual(
    ask.actions?.map((a) => a.label),
    ["Approve", "Change", "Stop"],
  );
  assert.deepEqual(ask.actions?.[0].request, {
    path: `/browser/tasks/${task.id}/answer`,
    body: { questionId: waiting.question!.id, answer: "approve" },
  });
  assert.equal(ask.actions?.[1].window, "browser");
  // No order went through, and the brain's own retry without the token is refused while it waits.
  assert.equal(t.mac.calls.filter((c) => c.kind === "browser.click").length, 1);
  assert.match(await t.tryCall("browser_click", { ref: 7 }), /You're waiting for Matthew/);

  // Matthew taps Approve on the card (POST /browser/tasks/:id/answer).
  const answered = (await t.route("POST", "/browser/tasks/:id/answer").handler(t.req({ id: task.id }, { questionId: waiting.question!.id, answer: "approve" }))) as BrowserTaskSummary;
  assert.equal(answered.status, "running");
  await settle();
  assert.match(t.brain.turns[1], /Matthew approved: “OK to click ‘Place order’/);
  const clicks = t.mac.calls.filter((c) => c.kind === "browser.click");
  assert.equal(clicks.length, 2);
  assert.deepEqual(clicks[1].payload.task, { taskId: task.id, mode: "normal", approval: "appr-1" });
  assert.ok(t.events.some((e) => e.type === "card.dismiss" && e.id === `browser-task-${task.id}-question`));
  const done = t.runner.get(task.id)!;
  assert.equal(done.status, "done");
  assert.ok(done.log.some((s) => s.kind === "approval" && s.text.startsWith("Matthew approved")), "the approval is in the log");
  assert.ok(done.log.some((s) => s.kind === "approval" && s.text.startsWith("Used Matthew's approval")));
});

test("an approval token is Matthew's, and good for one step", async () => {
  const open = gate();
  const t = setup([
    async (call) => {
      await call("browser_ask", { question: "Place the order for £18?", kind: "approval" });
    },
    open.turn,
  ]);
  const task = t.runner.start({ text: "Reorder coffee", origin: "browser" });
  await settle();
  assert.match(await t.tryCall("browser_click", { ref: 7, approval: "appr-made-up" }), /waiting for Matthew/);
  t.runner.answer(task.id, { questionId: t.runner.get(task.id)!.question!.id, answer: "approve" });
  await settle();
  // The brain's next turn is under way: its calls now act for the task.
  assert.match(await t.tryCall("browser_click", { ref: 7, approval: "appr-made-up" }), /isn't one Matthew gave/);
  assert.match(await t.tryCall("browser_click", { ref: 7, approval: "appr-1" }), /Now on “Checkout · Shop”/);
  assert.match(await t.tryCall("browser_click", { ref: 7, approval: "appr-1" }), /isn't one Matthew gave \(or it was used already\)/);
  open.end();
});

test("Full autonomy (from the request's words) clicks “Place order” without asking", async () => {
  const t = setup([
    async (call) => {
      await call("browser_open", { url: "https://shop.example/checkout" });
      await call("browser_click", { ref: 7 });
      await call("browser_done", { summary: "Ordered." });
    },
  ]);
  const task = t.runner.start({ text: "Reorder my usual coffee, do it on your own", origin: "desk-voice" });
  assert.equal(task.mode, "full");
  await settle();
  assert.match(t.brain.turns[0], /FULL AUTONOMY/);
  assert.equal(notices(t.events).length, 0);
  assert.deepEqual(t.mac.calls.find((c) => c.kind === "browser.click")!.payload.task, { taskId: task.id, mode: "full" });
  assert.equal(t.runner.get(task.id)!.status, "done");
  // Asked by voice: spoken, and in the chat as JARVIS's reply.
  assert.ok(t.events.some((e) => e.type === "browser.say" && e.text === "Ordered."));
  assert.deepEqual(
    t.chat.map((m) => [m.from, m.channel, m.text]),
    [["jarvis", "desk-voice", "Ordered."]],
  );
  assert.ok(t.events.some((e) => e.type === "brain.done" && e.messageId === `browser-task-${task.id}` && e.text === "Ordered."));
});

for (const mode of ["normal", "full"] as const) {
  test(`${mode} mode stops at a password field: Matthew takes over, types it, hands back`, async () => {
    let reply = "";
    const t = setup([
      async (call) => {
        await call("browser_open", { url: "https://shop.example/account" });
        reply = await call("browser_type", { ref: 9, text: "hunter2" }).catch((e: Error) => e.message);
      },
      async (call) => {
        await call("browser_done", { summary: "Signed in and renewed the permit." });
      },
    ]);
    const task = t.runner.start({ text: "Renew my parking permit", mode, origin: "browser" });
    await settle();
    assert.match(reply, /Matthew types that himself/);
    const waiting = t.runner.get(task.id)!;
    assert.equal(waiting.status, "waiting");
    assert.equal(waiting.question?.kind, "takeover");
    assert.equal(waiting.question?.text, "The page on shop.example asks for a password. Take over, type it yourself, then Hand back.");
    const [ask] = notices(t.events);
    assert.equal(ask.title, "Over to you in the browser");
    assert.deepEqual(
      ask.actions?.map((a) => a.label),
      ["Open browser", "Stop"],
    );
    // An approval doesn't get JARVIS past it: only Matthew's Hand back (the window POSTs /resume).
    await t.route("POST", "/browser/tasks/:id/resume").handler(t.req({ id: task.id }));
    await settle();
    assert.match(t.brain.turns[1], /handed the browser back/);
    assert.equal(t.runner.get(task.id)!.status, "done");
  });
}

test("Matthew taking over mid-task makes it wait; Hand back carries on", async () => {
  const t = setup([
    async (call) => {
      t.mac.takenOver = true;
      assert.match(await call("browser_snapshot").catch((e: Error) => e.message), /Matthew has taken over the browser/);
    },
    async (call) => void (await call("browser_done", { summary: "Done." })),
  ]);
  const task = t.runner.start({ text: "Find the cheapest flight to Lisbon in March", origin: "browser" });
  await settle();
  assert.equal(t.runner.get(task.id)!.status, "waiting");
  assert.equal(notices(t.events).length, 0, "no card: he's driving already");
  t.mac.takenOver = false;
  t.runner.resume(task.id);
  await settle();
  assert.equal(t.runner.get(task.id)!.status, "done");
});

test("pause refuses the brain's next step until resume; stop ends the task", async () => {
  let paused = "";
  const t = setup([
    async (call) => {
      t.runner.pause(t.runner.active!.id);
      paused = await call("browser_snapshot").catch((e: Error) => e.message);
    },
    async (call) => {
      t.runner.stop(t.runner.active!.id);
      assert.match(await call("browser_snapshot").catch((e: Error) => e.message), /Matthew stopped the task/);
    },
  ]);
  const task = t.runner.start({ text: "Find flights", origin: "browser" });
  await settle();
  assert.match(paused, /Matthew paused the task/);
  assert.equal(t.runner.get(task.id)!.status, "paused");
  t.runner.resume(task.id);
  await settle();
  assert.match(t.brain.turns[1], /Matthew resumed the task/);
  const stopped = t.runner.get(task.id)!;
  assert.equal(stopped.status, "stopped");
  assert.equal(t.brain.turns.length, 2);
  assert.ok(stopped.log.some((s) => s.kind === "pause") && stopped.log.some((s) => s.kind === "stop"));
});

test("Change sends Matthew's words back as the next message", async () => {
  const t = setup([async (call) => void (await call("browser_ask", { question: "Book 20:00 for 2?", kind: "approval" })), async () => {}]);
  const task = t.runner.start({ text: "Book Lilia", origin: "browser" });
  await settle();
  const q = t.runner.get(task.id)!.question!;
  assert.throws(() => t.runner.answer(task.id, { questionId: q.id, answer: "change" }), /Say what to change/);
  t.runner.answer(task.id, { questionId: q.id, answer: "change", text: "Make it 21:00" });
  await settle();
  assert.match(t.brain.turns[1], /He says: “Make it 21:00”/);
  assert.throws(() => t.runner.answer(task.id, { questionId: q.id, answer: "approve" }), /isn't waiting/);
});

test("a turn that ends without browser_done is nudged, then the task fails and says so", async () => {
  const t = setup([async () => {}, async () => {}, async () => {}]);
  const task = t.runner.start({ text: "Find flights", origin: "telegram" });
  await settle();
  assert.equal(t.brain.turns.length, 3);
  assert.match(t.brain.turns[1], /without browser_done/);
  const failed = t.runner.get(task.id)!;
  assert.equal(failed.status, "failed");
  assert.match(t.telegram[0], /I couldn't finish “Find flights”/);
});

// ── Not connected, one at a time ──

test("with no Desk connected the tools say “The Desk isn't connected”", async () => {
  const t = setup([], { clients: 0 });
  t.mac.connectedNow = false;
  assert.equal(await t.tool("browser_task").handler({ task: "Book Lilia", from: "telegram" }, t.ctx), NOT_CONNECTED);
  assert.match(NOT_CONNECTED, /^The Desk isn't connected/);
  assert.throws(() => t.runner.start({ text: "Book Lilia", origin: "browser" }), /The Desk isn't connected/);
  assert.match(await t.tryCall("browser_open", { url: "x.example" }), /No browser task is running/);
});

test("one task at a time; the chat brain starts one with browser_task and controls it with browser_task_control", async () => {
  const open = gate();
  const t = setup([async (call) => void (await call("browser_ask", { question: "Which flight: 07:10 £48 or 19:30 £61?" })), open.turn]);
  const out = await t.tool("browser_task").handler({ task: "Find the cheapest flight to Lisbon in March", from: "telegram" }, t.ctx);
  assert.match(out, /Started in the Browser window \(Normal mode/);
  await settle();
  assert.throws(() => t.runner.start({ text: "Another", origin: "browser" }), /already waiting/);
  assert.match(await t.tool("browser_task_control").handler({ action: "status" }, t.ctx), /Waiting on: Which flight/);
  assert.match(t.telegram[0], /🌐 Which flight: 07:10 £48 or 19:30 £61\?\nReply with your answer/);
  await t.tool("browser_task_control").handler({ action: "reply", text: "the 07:10" }, t.ctx);
  await settle();
  assert.match(t.brain.turns[1], /Matthew answered your question “Which flight[^”]*”: “the 07:10”/);
  await t.tool("browser_task_control").handler({ action: "stop" }, t.ctx);
  open.end();
  assert.match(await t.tool("browser_task_control").handler({ action: "status" }, t.ctx), /No browser task is running. The last one \(“Find the cheapest flight to Lisbon in March”\) stopped/);
});

// ── Logs and routes ──

test("History: the last 30 days, newest first, each with its log; older ones are dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-browser-log-"));
  const old = new Date(Date.now() - (KEEP_DAYS + 1) * 24 * 60 * 60_000).toISOString();
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  const task = (id: string, startedAt: string, status: string) => ({ id, text: id, mode: "normal", status, origin: "browser", startedAt, steps: 1, log: [{ at: startedAt, kind: "start", text: id }], approvals: [] });
  writeFileSync(join(dir, "browser-tasks.json"), JSON.stringify({ tasks: [task("running-at-restart", recent, "running"), task("recent", recent, "done"), task("old", old, "done")] }));
  const runner = new BrowserTaskRunner({ dataDir: dir, bus: new EventBus(), brain: new FakeBrain([]), mac: new FakeMac() });
  assert.deepEqual(
    runner.list().map((t) => [t.id, t.status]),
    [
      ["running-at-restart", "failed"],
      ["recent", "done"],
    ],
  );
  assert.equal(runner.get("running-at-restart")!.result, "JARVIS restarted while this was running.");
  assert.equal(runner.get("recent")!.log.length, 1);
  assert.equal("approvals" in runner.get("recent")!, false, "tokens never leave the server");
});

test("the Desk routes: start from the task box, list, read a log, 400 for a second task, 404 for none", async () => {
  const t = setup([async (call) => void (await call("browser_ask", { question: "OK?", kind: "approval" }))]);
  const started = (await t.route("POST", "/browser/tasks").handler(t.req({}, { text: "Book Lilia for Friday 8pm for 2", mode: "full" }))) as BrowserTaskSummary;
  assert.equal(started.origin, "browser");
  assert.equal(started.mode, "full");
  await settle();
  await assert.rejects(Promise.resolve().then(() => t.route("POST", "/browser/tasks").handler(t.req({}, { text: "Another" }))), (err: Error & { status?: number }) => err.status === 400);
  const list = (await t.route("GET", "/browser/tasks").handler(t.req())) as { tasks: BrowserTaskSummary[] };
  assert.equal(list.tasks[0].id, started.id);
  const one = (await t.route("GET", "/browser/tasks/:id").handler(t.req({ id: started.id }))) as { log: unknown[] };
  assert.ok(one.log.length >= 2);
  await assert.rejects(Promise.resolve().then(() => t.route("GET", "/browser/tasks/:id").handler(t.req({ id: "nope" }))), (err: Error & { status?: number }) => err.status === 404);
  await assert.rejects(
    Promise.resolve().then(() => t.route("POST", "/browser/tasks/:id/answer").handler(t.req({ id: started.id }, { answer: "maybe" }))),
    (err: Error & { status?: number }) => err.status === 400,
  );
  const stopped = (await t.route("POST", "/browser/tasks/:id/stop").handler(t.req({ id: started.id }))) as BrowserTaskSummary;
  assert.equal(stopped.status, "stopped");
});

test("deleting a finished task removes it from browser-tasks.json and list(); an active one must be stopped first", async () => {
  const t = setup([async (call) => void (await call("browser_ask", { question: "OK?", kind: "approval" }))]);
  const task = t.runner.start({ text: "Renew the parking permit", origin: "browser" });
  await settle();
  assert.throws(() => t.runner.forget(task.id), /waiting\. Stop it first/);
  assert.throws(() => t.runner.forget("nope"), /No browser task nope/);
  t.runner.stop(task.id);
  await settle();
  await t.runner.forget(task.id);
  assert.deepEqual(t.runner.list(), []);
  assert.equal(t.runner.get(task.id), undefined);
  const stored = JSON.parse(readFileSync(join(t.dir, "browser-tasks.json"), "utf8")) as { tasks: { id: string }[] };
  assert.equal(stored.tasks.some((x) => x.id === task.id), false, "gone from the 30-day log on disk");
  const reopened = new BrowserTaskRunner({ dataDir: t.dir, bus: new EventBus(), brain: new FakeBrain([]), mac: new FakeMac() });
  assert.equal(reopened.get(task.id), undefined, "still gone after a restart");
});

test("the delete routes: POST …/delete and DELETE …/:id answer with the list left; 400 while active, 404 for none", async () => {
  const t = setup([async (call) => void (await call("browser_ask", { question: "OK?", kind: "approval" }))]);
  const first = t.runner.start({ text: "Find flights", origin: "browser" });
  await settle();
  const del = t.route("POST", "/browser/tasks/:id/delete");
  await assert.rejects(Promise.resolve().then(() => del.handler(t.req({ id: first.id }))), (err: Error & { status?: number }) => err.status === 400 && /Stop it first/.test(err.message));
  await assert.rejects(Promise.resolve().then(() => del.handler(t.req({ id: "nope" }))), (err: Error & { status?: number }) => err.status === 404);
  t.runner.stop(first.id);
  await settle();
  const left = (await del.handler(t.req({ id: first.id }))) as { tasks: BrowserTaskSummary[] };
  assert.deepEqual(left.tasks, []);

  const second = t.runner.start({ text: "Find hotels", origin: "browser" });
  await settle();
  t.runner.stop(second.id);
  await settle();
  const viaDelete = (await t.route("DELETE", "/browser/tasks/:id").handler(t.req({ id: second.id }))) as { tasks: BrowserTaskSummary[] };
  assert.deepEqual(viaDelete.tasks, []);
  await assert.rejects(Promise.resolve().then(() => t.route("GET", "/browser/tasks/:id").handler(t.req({ id: second.id }))), (err: Error & { status?: number }) => err.status === 404);
});

// ── Which brain gets which tools ──

test("only the browser brain gets the browser_* step tools; the chat brain is blocked from them", async () => {
  const setupFor = browserSetup("/data");
  assert.deepEqual(setupFor.jarvisTools, [...BROWSER_TASK_TOOLS, "add_task"], "plus add_task: a result onto his to-do list (JD-66)");
  assert.deepEqual(BROWSER_BRAIN_TASK_TOOLS, ["add_task"], "nothing else of the tasks group, and nothing else in Notion");
  assert.ok(BROWSER_TASK_TOOLS.includes("browser_click") && BROWSER_TASK_TOOLS.includes("browser_ask") && BROWSER_TASK_TOOLS.includes("browser_done"));
  assert.ok(!BROWSER_TASK_TOOLS.includes("browser_task"));
  assert.deepEqual(setupFor.allowedTools, [], "no claude.ai connectors (and so --strict-mcp-config)");
  assert.deepEqual(setupFor.builtinTools, ["Read"]);

  const dir = mkdtempSync(join(tmpdir(), "jarvis-browser-reg-"));
  const jarvis = new Jarvis({ dataDir: dir, brainConnectors: [] } as unknown as Config, new Store(dir));
  const registry = await ToolRegistry.discover();
  const chat = await registry.brainSetup({ jarvis, config: jarvis.config });
  for (const name of BROWSER_TASK_TOOLS) assert.ok(chat.disallowedTools.includes(`mcp__jarvis__${name}`), name);
  assert.ok(!chat.disallowedTools.includes("mcp__jarvis__browser_task"));
  assert.ok(registry.has("browser_task_control"));
  assert.ok(chat.hints.some((h) => h.includes("browser_task")));
});

test("the browser brain runs on the worker's model with only its own tools, a long turn and its own conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-browser-cli-"));
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({ type: "result", result: "ok", num_turns: 3 })));
`,
  );
  chmodSync(bin, 0o755);
  const brain = createBrowserBrain({ claudeBin: bin, dataDir: dir, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], defaultModel: "claude-sonnet-5-5", internalUrl: "http://127.0.0.1:1", internalToken: "t" });
  await brain.chat("Task from Matthew: find flights", "worker");
  const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
  const arg = (flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(arg("--model"), "claude-haiku-5-5");
  assert.equal(arg("--system-prompt"), BROWSER_TASK_PROMPT);
  assert.equal(arg("--tools"), "Read");
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.deepEqual(arg("--allowedTools").split(","), [...BROWSER_TASK_TOOLS, "add_task"].map((t) => `mcp__jarvis__${t}`));
  assert.ok(argv.includes("--session-id"));
  assert.equal(BROWSER_TURN_MS, 15 * 60_000);
  assert.ok(existsSync(join(dir, "browser-worker.json")), "its usage is kept apart from the worker's");
});

// ── Results and follow-ups (JD-66) ──

const FLIGHTS = {
  title: "Tampa → Johannesburg, Dec 10–12",
  items: [
    { label: "Fri Dec 11 · JetBlue + Turkish", detail: "$958", url: "https://skyfare.example/fare/tpa-jnb-dec11-958" },
    { label: "Thu Dec 10 · Air Canada + Emirates", detail: "$1,188", url: "javascript:alert(1)" },
    { label: "Sat Dec 12 · cheapest date", detail: "$1,018" },
  ],
};

test("a result item's url goes browser_done → the task's results → the card; only http(s) urls", async () => {
  const t = setup([async (call) => void (await call("browser_done", { summary: "Found 3 options.", card: FLIGHTS }))]);
  const task = t.runner.start({ text: "Find one-way flights, Tampa to Johannesburg, Dec 10–12", origin: "telegram" });
  await settle();
  const done = t.runner.get(task.id)!;
  assert.equal(done.results?.title, FLIGHTS.title);
  assert.deepEqual(
    done.results?.items.map((i) => i.url),
    ["https://skyfare.example/fare/tpa-jnb-dec11-958", undefined, undefined],
  );
  assert.deepEqual(t.runner.list()[0].results, done.results, "the Browser window's list has them too");
  const [card] = cards(t.events);
  assert.deepEqual(card.card.items?.[0], { label: "Fri Dec 11 · JetBlue + Turkish", detail: "$958", url: "https://skyfare.example/fare/tpa-jnb-dec11-958" });
  assert.equal(card.card.items?.[1].url, undefined);
  assert.ok(t.events.some((e) => e.type === "browser.task" && e.task.status === "done" && e.task.results?.items.length === 3));
});

test("asked from the Browser window, the results go to its results panel, not a card beside the orb", async () => {
  const t = setup([async (call) => void (await call("browser_done", { summary: "Found 3 options.", card: FLIGHTS }))]);
  const task = t.runner.start({ text: "Find flights", origin: "browser" });
  await settle();
  assert.equal(cards(t.events).length, 0);
  assert.equal(t.runner.get(task.id)!.results?.items.length, 3);
});

test("a done task takes a follow-up on the same conversation (no reset) and browses again to answer", async () => {
  const t = setup([
    async (call) => {
      await call("browser_open", { url: "https://skyfare.example/search" });
      await call("browser_done", { summary: "Found 3 options. Cheapest is Fri Dec 11 at $958.", card: FLIGHTS });
    },
    async (call) => {
      await call("browser_open", { url: "https://skyfare.example/fare/tpa-jnb-dec11-958", step: "Opening the Dec 11 fare" });
      assert.match(await call("browser_snapshot"), /Check availability/);
      await call("browser_done", { summary: "It has 2 stops: Toronto, then Istanbul." });
    },
  ]);
  const task = t.runner.start({ text: "Find one-way flights, Tampa to Johannesburg, Dec 10–12", origin: "browser" });
  await settle();
  assert.equal(t.runner.get(task.id)!.status, "done");

  const again = t.runner.followUp(task.id, { text: "Where are the stops?", item: 0 });
  assert.equal(again.status, "running");
  assert.equal(again.step, "Following up");
  await settle();

  assert.equal(t.brain.resets, 1, "the follow-up carries on the same conversation");
  assert.equal(t.brain.turns.length, 2);
  assert.match(t.brain.turns[1], /Matthew follows up on the task \(“Find one-way flights[^”]*”; you finished with: “Found 3 options/);
  assert.match(t.brain.turns[1], /About this result: Fri Dec 11 · JetBlue \+ Turkish · \$958 · https:\/\/skyfare.example\/fare\/tpa-jnb-dec11-958/);
  assert.match(t.brain.turns[1], /He says:\nWhere are the stops\?/);
  assert.deepEqual(t.mac.kinds(), ["browser.open", "browser.open", "browser.snapshot"], "the reopened task can use the browser again");
  assert.ok(t.mac.statuses().includes("Following up: Where are the stops?"));

  const done = t.runner.get(task.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.result, "It has 2 stops: Toronto, then Istanbul.");
  assert.equal(done.results?.items.length, 3, "an answer without a card keeps the results");
  const followed = done.log.find((s) => s.kind === "answer")!;
  assert.equal(followed.text, "Matthew followed up on “Fri Dec 11 · JetBlue + Turkish”: Where are the stops?");
  assert.equal(followed.url, "https://skyfare.example/fare/tpa-jnb-dec11-958");
  assert.deepEqual(
    done.log.map((s) => s.kind),
    ["start", "action", "done", "answer", "action", "done"],
  );
  // And once more: a done task can be followed up as long as it's still the newest.
  assert.equal(t.runner.followUp(task.id, { text: "Thanks" }).status, "running");
});

test("a follow-up's answer goes back where the follow-up was asked", async () => {
  const t = setup([
    async (call) => void (await call("browser_done", { summary: "Found 3 options.", card: FLIGHTS })),
    async (call) => void (await call("browser_done", { summary: "Added “Book flight: Fri Dec 11, JetBlue + Turkish, $958” to your to-do list." })),
  ]);
  const task = t.runner.start({ text: "Find flights", origin: "browser" });
  await settle();
  const out = await t.tool("browser_task_control").handler({ action: "follow_up", text: "add the first one to my to-do list", from: "desk-typed" }, t.ctx);
  assert.match(out, /Following up on “Find flights”/);
  await settle();
  assert.deepEqual(
    t.chat.map((m) => [m.channel, m.text]),
    [["desk-typed", "Added “Book flight: Fri Dec 11, JetBlue + Turkish, $958” to your to-do list."]],
  );
  const done = t.events.filter((e): e is Extract<DeskEvent, { type: "brain.done" }> => e.type === "brain.done");
  assert.equal(done.length, 1);
  assert.notEqual(done[0].messageId, `browser-task-${task.id}`, "its own chat message, not the task's first reply");
  assert.equal(cards(t.events).length, 1, "a text card for the chat's answer");
});

test("a follow-up is refused once a different task has started, while one runs, or when it didn't finish", async () => {
  const open = gate();
  const t = setup([
    async (call) => void (await call("browser_done", { summary: "First." })),
    async (call) => void (await call("browser_done", { summary: "Second." })),
    open.turn,
  ]);
  const first = t.runner.start({ text: "First task", origin: "browser" });
  await settle();
  assert.throws(() => t.runner.followUp(first.id, { text: "  " }), /Say what to do with it/);
  assert.throws(() => t.runner.followUp(first.id, { text: "This one", item: 5 }), /That result isn't on the task/);
  const second = t.runner.start({ text: "Second task", origin: "browser" });
  await settle();
  assert.throws(() => t.runner.followUp(first.id, { text: "More about it" }), /Another browser task has started since/);
  assert.equal(t.brain.turns.length, 2, "no turn was taken for the refused follow-up");
  t.runner.followUp(second.id, { text: "And?" });
  await settle();
  assert.throws(() => t.runner.followUp(second.id, { text: "And?" }), /already running/);
  t.runner.stop(second.id);
  open.end();
  assert.throws(() => t.runner.followUp(second.id, { text: "And?" }), /was stopped/);
  const third = setup([async (call) => void (await call("browser_done", { summary: "Done." }))]);
  const task = third.runner.start({ text: "Third", origin: "browser" });
  await settle();
  third.mac.connectedNow = false;
  assert.throws(() => third.runner.followUp(task.id, { text: "And?" }), /The Desk isn't connected/);
});

test("the follow-up route: 200 with the reopened task, 404 for none, 400 when it can't be picked up", async () => {
  const t = setup([async (call) => void (await call("browser_done", { summary: "Found 3 options.", card: FLIGHTS }))]);
  const task = t.runner.start({ text: "Find flights", origin: "browser" });
  await settle();
  const route = t.route("POST", "/browser/tasks/:id/followup");
  await assert.rejects(Promise.resolve().then(() => route.handler(t.req({ id: "nope" }, { text: "hi" }))), (err: Error & { status?: number }) => err.status === 404);
  await assert.rejects(Promise.resolve().then(() => route.handler(t.req({ id: task.id }, { text: "" }))), (err: Error & { status?: number }) => err.status === 400);
  const reopened = (await route.handler(t.req({ id: task.id }, { text: "Is it refundable?", item: 0 }))) as BrowserTaskSummary;
  assert.equal(reopened.status, "running");
  assert.match(t.runner.get(task.id)!.log.at(-1)!.text, /followed up on “Fri Dec 11/);
});

test("the reopened conversation resumes the browser brain's session (--resume), it isn't reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-browser-resume-"));
  const bin = join(dir, "claude");
  const argvLog = join(dir, "argv.jsonl");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({ type: "result", result: "ok", num_turns: 1 })));
`,
  );
  chmodSync(bin, 0o755);
  const real = createBrowserBrain({ claudeBin: bin, dataDir: dir, models: ["claude-haiku-5-5"], defaultModel: "claude-haiku-5-5", internalUrl: "http://127.0.0.1:1", internalToken: "t" });
  let resets = 0;
  // The real brain runs the CLI; the browser_* calls it would make come straight from here.
  const summaries = ["Found it.", "Yes, it's refundable."];
  const t = setup([]);
  const runner = new BrowserTaskRunner({ dataDir: dir, bus: new EventBus(), mac: t.mac, brain: {
    reset: () => void (resets++, real.reset()),
    chat: async (text) => {
      await real.chat(text, "worker");
      await t.tool("browser_open").handler({ url: "https://skyfare.example" }, ctx);
      await t.tool("browser_done").handler({ summary: summaries.shift() }, ctx);
    },
  } });
  const jarvis = new Jarvis({ dataDir: dir, brainConnectors: [] } as unknown as Config, new Store(dir));
  useBrowserTasks(jarvis, runner);
  const ctx: ToolContext = { jarvis, config: jarvis.config, desk: { bus: new EventBus(), hub: { clientCount: 1 } } as unknown as DeskContext };
  const task = runner.start({ text: "Find a flight", origin: "browser" });
  await settle();
  for (let i = 0; i < 50 && runner.get(task.id)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.get(task.id)!.status, "done");
  runner.followUp(task.id, { text: "Is it refundable?" });
  for (let i = 0; i < 50 && runner.get(task.id)!.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.get(task.id)!.result, "Yes, it's refundable.");
  assert.equal(resets, 1);
  const runs = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.equal(runs.length, 2);
  const session = runs[0][runs[0].indexOf("--session-id") + 1];
  assert.ok(session);
  assert.equal(runs[1][runs[1].indexOf("--resume") + 1], session, "the follow-up resumes the task's conversation");
  assert.deepEqual(t.mac.kinds(), ["browser.open", "browser.open"]);
});

test("a follow-up asked while the last turn is still winding down retires that turn's loop (no nudge, no second loop)", async () => {
  const winding = gate();
  const answering = gate();
  const t = setup([
    async (call) => {
      await call("browser_done", { summary: "Found 3 options.", card: FLIGHTS });
      await winding.turn(); // the CLI's turn goes on a moment after browser_done
    },
    async (call) => {
      await answering.turn();
      await call("browser_done", { summary: "It's refundable.", card: { title: "Just a title" } });
    },
  ]);
  const task = t.runner.start({ text: "Find flights", origin: "telegram" });
  await settle();
  assert.equal(t.runner.get(task.id)!.status, "done");
  t.runner.followUp(task.id, { text: "Is the first one refundable?", item: 0 }, "telegram");
  await settle();
  winding.end(); // the old turn ends while the follow-up's is still working
  await settle();
  answering.end();
  await settle();
  assert.equal(t.brain.turns.length, 2, "no “You ended your turn without browser_done” nudge");
  const done = t.runner.get(task.id)!;
  assert.equal(done.status, "done");
  assert.equal(done.result, "It's refundable.");
  assert.equal(done.results?.items.length, 3, "a card with no rows keeps the earlier results");
  const shown = cards(t.events);
  assert.deepEqual(
    shown.map((c) => [c.card.id === `browser-task-${task.id}`, c.card.kind]),
    [
      [true, "list"],
      [false, "text"],
    ],
    "the follow-up's answer is its own card; the list card stays",
  );
  assert.deepEqual(t.telegram, ["🌐 Found 3 options.", "🌐 It's refundable."]);
});

test("browser_task_control follow_up needs the channel it was asked on", async () => {
  const t = setup([async (call) => void (await call("browser_done", { summary: "Found it." }))]);
  t.runner.start({ text: "Find flights", origin: "browser" });
  await settle();
  assert.match(await t.tool("browser_task_control").handler({ action: "follow_up", text: "And?" }, t.ctx), /Give `from`/);
  assert.equal(t.brain.turns.length, 1);
});

test("deleting the newest task (JD-67) doesn't hand its conversation to the one before", async () => {
  const t = setup([
    async (call) => void (await call("browser_done", { summary: "First." })),
    async (call) => void (await call("browser_done", { summary: "Second." })),
  ]);
  const first = t.runner.start({ text: "First task", origin: "browser" });
  await settle();
  const second = t.runner.start({ text: "Second task", origin: "browser" });
  await settle();
  await t.runner.forget(second.id);
  assert.equal(t.runner.list()[0].id, first.id);
  assert.throws(() => t.runner.followUp(first.id, { text: "And?" }), /Another browser task has started since/);
});
