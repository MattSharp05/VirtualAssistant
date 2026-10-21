import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent, MoodResponse } from "@jarvis/shared";
import type { Config } from "../src/config.js";
import moodRoutes from "../src/desk/routes/mood.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { Notifier } from "../src/notify.js";
import { classify, ReportWatcher, useReportWatcher, type ReportClass } from "../src/notifyRules.js";
import { Store } from "../src/store.js";
import type { PlanUsage } from "../src/usage.js";

test("session reports classify into blocked / decision / finished / failed / info", () => {
  // Lines in the style of the Kart Racer and Trip orchestrators' reports.
  const table: [string, ReportClass][] = [
    ["⛔ MK-52 blocked: the Vercel token expired, needs a new one", "blocked"],
    ["MK-61 is blocked on the asset licence question", "blocked"],
    ["Builder stuck on the Supabase migration, can't continue without the service key", "blocked"],
    ["TR-14 needs a decision: Booking.com API or Skyscanner? Recommendation: Skyscanner", "decision"],
    ["Waiting on Matthew: approve the hotel budget cap before TR-20", "decision"],
    ["Batch 3 done ✅ — 6 tickets in QA Pending, test order in the handover", "finished"],
    ["Handed batch 2 to QA: 5 tickets ready for you", "finished"],
    ["CI red on main after MK-70; reverting", "failed"],
    ["❌ desk-mac build failed on electron-builder signing", "failed"],
    ["MK-74 merged ✅ — 3/5", "info"],
    ["Started builders for MK-75 and MK-76", "info"],
    ["Wave 4 in progress: 2 PRs open, CI running", "info"],
  ];
  for (const [line, expected] of table) assert.equal(classify(line), expected, line);
});

function setup(usage?: PlanUsage) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-notify-"));
  const store = new Store(dir);
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const telegram: string[] = [];
  const notifier = new Notifier(bus);
  notifier.attachTelegram(async (t) => void telegram.push(t));
  const watcher = new ReportWatcher(store, bus, notifier, async () => usage);
  watcher.start();
  return { dir, store, events, telegram, notifier, watcher };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const usage = (percent: number): PlanUsage => ({ available: true, windows: [{ name: "five_hour", percent }], checkedAt: "" });

test("mood: red on a blocked report, green again when that session's next report isn't blocked; amber at 75% usage", async (t) => {
  const s = setup();
  t.after(() => s.watcher.stop());
  s.store.addReport("mk", "⛔ MK-52 blocked: needs a Vercel token", "session_01MK");
  await settle();
  assert.equal(s.watcher.mood.mood, "red");
  assert.match(s.watcher.mood.reason, /mk is blocked/);
  const alert = s.events.find((e) => e.type === "notice");
  assert.ok(alert?.type === "notice" && alert.level === "alert" && alert.title === "⛔ mk is blocked" && alert.link === "https://claude.ai/code/session_01MK");
  assert.ok(alert?.type === "notice");
  assert.deepEqual(alert.actions, [{ label: "Open session", window: "sessions", params: { id: "mk" } }, { label: "Later" }], "the Desk card opens the session or waits");
  assert.equal(s.telegram[0], "⛔ mk is blocked\n⛔ MK-52 blocked: needs a Vercel token\nhttps://claude.ai/code/session_01MK");
  assert.deepEqual(s.events.filter((e) => e.type === "mood.changed").at(-1), { type: "mood.changed", mood: "red", reason: "mk is blocked" });

  s.store.addReport("trip", "TR-14 needs a decision: which flights API?", "session_01TR");
  await settle();
  assert.equal(s.watcher.mood.mood, "red", "blocked outranks waiting");
  s.store.addReport("mk", "Unblocked, MK-52 merged ✅", "session_01MK");
  await settle();
  assert.deepEqual(s.watcher.mood, { mood: "amber", reason: "trip waits on a decision" });
  s.store.addReport("trip", "TR-14 merged ✅", "session_01TR");
  await settle();
  assert.equal(s.watcher.mood.mood, "green");
  assert.equal(s.telegram.length, 2, "info reports send nothing; blocked + decision did");

  const busy = setup(usage(80));
  t.after(() => busy.watcher.stop());
  await busy.watcher.recompute();
  assert.deepEqual(busy.watcher.mood, { mood: "amber", reason: "plan usage at 80% of the 5-hour window" });
  assert.equal((await setup(usage(74)).watcher.recompute()).mood, "green");
});

test("Do Not Disturb keeps notices off Telegram but still publishes them; GET /mood and POST /dnd", async (t) => {
  const s = setup();
  t.after(() => s.watcher.stop());
  const jarvis = new Jarvis({ dataDir: s.dir } as unknown as Config, s.store);
  useReportWatcher(jarvis, s.watcher);
  const ctx = { jarvis } as unknown as DeskContext;
  const route = (path: string) => moodRoutes.find((r) => r.path === path)!;

  assert.deepEqual(await route("/dnd").handler({ body: { on: true }, ctx } as never), { on: true });
  s.store.addReport("mk", "Batch 3 done ✅ — ready for QA", "session_01MK");
  await settle();
  assert.equal(s.telegram.length, 0, "nothing sent to Telegram");
  assert.ok(s.events.some((e) => e.type === "notice" && e.title === "✅ mk finished"), "the notice is still published");
  const mood = (await route("/mood").handler({ ctx } as never)) as MoodResponse;
  assert.deepEqual(mood, { mood: "green", reason: "all fine", dnd: { on: true } });

  // DND with an end time switches itself off.
  s.notifier.setDnd(true, new Date(Date.now() - 1000).toISOString());
  assert.deepEqual(s.notifier.dnd, { on: false });
  await route("/dnd").handler({ body: { on: false }, ctx } as never);
  s.store.addReport("mk", "⛔ blocked again", "session_01MK");
  await settle();
  assert.equal(s.telegram.length, 1);
  await assert.rejects(Promise.resolve().then(() => route("/dnd").handler({ body: { on: true, until: "soon" }, ctx } as never)), /until must be/);
});

test("Telegram files: canSendFiles and sendTelegramFile follow attachTelegramFile; failures reach the caller", async () => {
  const notifier = new Notifier(new EventBus());
  const upload = { id: "0123456789ab", path: "/data/uploads/0123456789ab/shot.png", name: "shot.png" };
  assert.equal(notifier.canSendFiles, false);
  assert.equal(await notifier.sendTelegramFile(upload, "hi"), false, "not attached: nothing sent");

  const sent: [string, string | undefined][] = [];
  notifier.attachTelegramFile(async (u, caption) => void sent.push([u.name, caption]));
  assert.equal(notifier.canSendFiles, true);
  notifier.setDnd(true);
  assert.equal(await notifier.sendTelegramFile(upload, "your screen"), true, "asked-for files ignore DND");
  assert.deepEqual(sent, [["shot.png", "your screen"]]);

  notifier.attachTelegramFile(async () => {
    throw new Error("Bad Request: file is too big");
  });
  await assert.rejects(notifier.sendTelegramFile(upload), /file is too big/);
  notifier.attachTelegramFile(undefined);
  assert.equal(notifier.canSendFiles, false);
});
