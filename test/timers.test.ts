import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent } from "@jarvis/shared";
import { stamp } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import type { Notice } from "../src/notify.js";
import { Scheduler, useScheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";
import timers from "../src/tools/timers.js";

// Times show in Matthew's zone; tests pin it (each test file runs in its own process).
process.env.TZ = "Europe/London";
const T0 = Date.parse("2026-10-14T09:00:00Z");

function setup(dir = mkdtempSync(join(tmpdir(), "jarvis-timers-")), start = T0) {
  let now = start;
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  const notices: Notice[] = [];
  bus.subscribe((e) => events.push(e));
  const scheduler = new Scheduler(dir, { bus, notify: async (n) => void notices.push(n), now: () => now });
  return {
    dir,
    scheduler,
    events,
    notices,
    /** Moves the fake clock forward one second at a time, ticking like the real 1 s interval. */
    advance(ms: number) {
      for (let t = 0; t < ms; t += 1000) {
        now += 1000;
        scheduler.tick();
      }
    },
    at: () => now,
  };
}

test("a 25-minute timer fires at 25:00 (±1 s); cancel stops another", () => {
  const s = setup();
  const timer = s.scheduler.setTimer(25, "tea");
  const other = s.scheduler.setTimer(10);
  assert.deepEqual(s.events[0], { type: "timer.started", id: timer.id, endsAt: "2026-10-14T09:25:00.000Z", label: "tea" });
  s.scheduler.cancel(other.id);
  s.advance(25 * 60_000 - 2000);
  assert.equal(s.events.filter((e) => e.type === "timer.done").length, 0, "not before 24:58");
  s.advance(2000);
  const done = s.events.filter((e) => e.type === "timer.done");
  assert.deepEqual(done, [{ type: "timer.done", id: timer.id, label: "tea" }]);
  assert.ok(Math.abs(s.at() - (T0 + 25 * 60_000)) <= 1000);
  assert.deepEqual(s.notices, [{ title: "⏰ Timer done: tea", body: undefined, telegram: true }]);
  s.advance(60 * 60_000);
  assert.equal(s.events.filter((e) => e.type === "timer.done").length, 1, "the cancelled one never fires, and nothing fires twice");
  assert.throws(() => s.scheduler.setTimer(0), /between/);
});

test("reminders survive a restart, fire once, and ones missed while down fire on start marked late", async () => {
  const first = setup();
  first.scheduler.setReminder("2026-10-14T10:00:00Z", "call Sam");
  first.scheduler.setReminder("2026-10-14T12:00:00+01:00", "lunch");
  assert.throws(() => first.scheduler.setReminder("2026-10-14T08:00:00Z", "past"), /already passed/);
  assert.throws(() => first.scheduler.setReminder("Friday at 9", "x"), /isn't a date/);
  await new Promise((r) => setTimeout(r, 20)); // let the JSON file write

  // "Restart" at 10:30: call Sam was missed while down, lunch (11:00 UTC) hasn't come yet.
  const second = setup(first.dir, Date.parse("2026-10-14T10:30:00Z"));
  assert.equal(second.scheduler.list().length, 2, "loaded from disk");
  second.scheduler.tick(true);
  assert.deepEqual(second.events, [{ type: "reminder.due", id: second.events[0]?.type === "reminder.due" ? second.events[0].id : "", text: "call Sam", late: true }]);
  assert.equal(second.notices[0].title, "🔔 call Sam");
  assert.match(second.notices[0].body ?? "", /^\(late: was due \d\d:\d\d\)$/);
  second.advance(30 * 60_000);
  assert.deepEqual(
    second.events.filter((e) => e.type === "reminder.due").map((e) => (e.type === "reminder.due" ? [e.text, e.late] : [])),
    [["call Sam", true], ["lunch", false]],
  );
  second.advance(60 * 60_000);
  assert.equal(second.events.filter((e) => e.type === "reminder.due").length, 2, "each fires once");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(setup(first.dir).scheduler.list().length, 0, "fired reminders are gone from disk");
});

test("timer tools: set, list, cancel", async () => {
  const s = setup();
  const jarvis = new Jarvis({ dataDir: s.dir, timeZone: "Europe/London" } as unknown as Config, new Store(s.dir));
  useScheduler(jarvis, s.scheduler);
  const ctx = { jarvis, config: jarvis.config };
  const tool = (n: string) => timers.tools.find((t) => t.name === n)!;
  assert.match(await tool("set_timer").handler({ minutes: 1, label: "eggs" }, ctx), /Timer set for eggs: ends at \d\d:\d\d \[id (\w+)\]/);
  assert.match(await tool("set_reminder").handler({ at: "2026-10-17T09:00:00+01:00", text: "call Sam" }, ctx), /Reminder set for Sat 17 Oct 09:00: call Sam/);
  const list = await tool("list_timers").handler({}, ctx);
  assert.match(list, /timer "eggs"[\s\S]*reminder "call Sam"/);
  const id = /\[id (\w+)\]/.exec(list)![1];
  assert.match(await tool("cancel_timer").handler({ id }, ctx), /Cancelled the timer "eggs"/);
  assert.match(String(typeof timers.promptHint === "function" ? timers.promptHint(ctx) : ""), /Europe\/London/);
});

test("the brain sees the time in Matthew's zone", () => {
  assert.equal(stamp(new Date("2026-10-14T22:20:00Z"), "telegram", "Europe/London"), "[Wed 14 Oct 2026 23:20 Europe/London (UTC+01:00), via telegram]");
  assert.equal(stamp(new Date("2026-12-01T09:05:00Z"), "dashboard", "Europe/London"), "[Tue 1 Dec 2026 09:05 Europe/London (UTC+00:00), via dashboard]");
});
