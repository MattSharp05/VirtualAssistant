import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent } from "@jarvis/shared";
import { Brain } from "../src/brain/index.js";
import { CalendarLog, useCalendarLog } from "../src/calendarLog.js";
import type { Config } from "../src/config.js";
import calendarRoutes from "../src/desk/routes/calendar.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Store } from "../src/store.js";
import calendarTools from "../src/tools/calendar.js";

const CAL = "mcp__claude_ai_Google_Calendar__";
const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-cal-"));

/**
 * A stand-in stream-json CLI that plays a scripted list of tool calls per turn (by turn number),
 * like the real one does when the brain uses the calendar connector.
 */
function fakeCli(dir: string, turns: { name: string; input: unknown; result: string }[][]): string {
  const bin = join(dir, "claude-cal");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const turns = ${JSON.stringify(turns)};
let n = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  const calls = turns[n++] ?? [];
  calls.forEach((c, i) => {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t" + n + i, name: c.name, input: c.input }] }, parent_tool_use_id: null });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" + n + i, content: [{ type: "text", text: c.result }] }] }, parent_tool_use_id: null });
  });
  out({ type: "result", result: "done", num_turns: calls.length + 1, usage: {} });
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const BEFORE = JSON.stringify({ id: "ev1", summary: "Booking call", start: "2026-10-16T14:00:00+01:00", end: "2026-10-16T14:30:00+01:00" });

test("an update preceded by get_event is logged with before and after; undo hands back the reverse and marks it done", async (t) => {
  const dir = tmp();
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const bin = fakeCli(dir, [
    // Turn 1: "move the booking call to Friday 2pm"
    [
      { name: `${CAL}get_event`, input: { eventId: "ev1" }, result: BEFORE },
      { name: `${CAL}update_event`, input: { eventId: "ev1", startTime: "2026-10-17T14:00:00" }, result: '{"id":"ev1","start":"2026-10-17T14:00:00+01:00"}' },
    ],
    // Turn 2: "undo that" → the brain calls undo_calendar_change (a JARVIS tool), then reverses it.
    [{ name: `${CAL}update_event`, input: { eventId: "ev1", startTime: "2026-10-16T14:00:00" }, result: '{"id":"ev1","start":"2026-10-16T14:00:00+01:00"}' }],
    // Turn 3: a read and an RSVP; reads are never logged.
    [
      { name: `${CAL}list_events`, input: {}, result: "[]" },
      { name: `${CAL}respond_to_event`, input: { eventId: "ev2", responseStatus: "accepted" }, result: "ok" },
    ],
  ]);
  const store = new Store(dir);
  const brain = new Brain({ claudeBin: bin, dataDir: dir, models: ["m"], defaultModel: "m", internalUrl: "http://127.0.0.1:1", internalToken: "t", bus }, store);
  t.after(() => brain.stop());
  const log = new CalendarLog(dir, bus);
  log.attach(brain);
  const jarvis = new Jarvis({ dataDir: dir } as unknown as Config, store);
  useCalendarLog(jarvis, log);

  await brain.chat("move the booking call to Friday 2pm", "telegram");
  const [entry] = log.recent();
  assert.equal(entry.tool, "update_event");
  assert.equal(entry.before, BEFORE, "before = get_event's answer earlier in the turn");
  assert.match(entry.result, /2026-10-17T14:00/);
  assert.equal(entry.summary, "update_event: ev1 → 2026-10-17T14:00:00");
  assert.deepEqual(events.filter((e) => e.type === "calendar.changed").map((e) => e.type === "calendar.changed" && e.entry.id), [entry.id]);

  const undo = await calendarTools.tools[0].handler({}, { jarvis, config: jarvis.config });
  assert.match(undo, /Undoing update_event: ev1 → 2026-10-17T14:00:00/);
  assert.match(undo, /update_event on eventId ev1 to restore[\s\S]*Booking call/);
  await brain.chat("undo that", "telegram");
  const [reversal, original] = log.recent();
  assert.equal(reversal.undoOf, original.id);
  assert.ok(original.undoneAt, "marked undone after the brain's follow-up write");
  await assert.rejects(Promise.resolve().then(() => calendarTools.tools[0].handler({}, { jarvis, config: jarvis.config })), /no calendar change of mine to undo/);

  await brain.chat("accept the 3pm", "telegram");
  assert.equal(log.recent().length, 3, "list_events isn't logged");
  assert.equal(log.recent()[0].summary, "respond_to_event: ev2 → accepted");
  assert.equal(log.recent()[0].before, undefined);

  const res = (await calendarRoutes.find((r) => r.path === "/calendar/log")!.handler({ ctx: { jarvis } as unknown as DeskContext } as never)) as { changes: { tool: string }[] };
  assert.deepEqual(res.changes.map((c) => c.tool), ["respond_to_event", "update_event", "update_event"]);
});

test("undo instructions per kind of change", () => {
  const fresh = () => new CalendarLog(tmp());
  const write = (log: CalendarLog, name: string, input: unknown, result: string) => log.onTool({ messageId: "m1", phase: "result", name: CAL + name, input, result });

  const deleted = fresh();
  deleted.onTool({ messageId: "m1", phase: "result", name: `${CAL}get_event`, input: { eventId: "ev9" }, result: '{"summary":"Dentist"}' });
  write(deleted, "delete_event", { eventId: "ev9" }, "deleted");
  assert.match(deleted.undo().instructions, /Re-create the deleted event with create_event[\s\S]*Dentist/);

  const created = fresh();
  write(created, "create_event", { summary: "JARVIS test", startTime: "2026-10-15T15:00:00" }, '{"id":"new1"}');
  assert.match(created.undo().instructions, /Delete the event it created[\s\S]*new1/);

  // An errored tool call is never logged.
  const failed = fresh();
  failed.onTool({ messageId: "m3", phase: "result", name: `${CAL}update_event`, input: { eventId: "x" }, result: "boom", isError: true });
  assert.equal(failed.recent().length, 0);
});
