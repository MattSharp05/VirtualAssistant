import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrainChannel, BriefResponse, ChatResponse, DeskEvent, Digest } from "@jarvis/shared";
import type { BrainReply, ChatOptions } from "../src/brain/index.js";
import { briefPrompt, BriefService, dayIn, overnightSince, useBrief, type BriefBrain } from "../src/brief.js";
import briefRoute from "../src/desk/routes/brief.js";
import chatRoutes from "../src/desk/routes/chat.js";

const chatRoute = chatRoutes.find((r) => r.method === "POST" && r.path === "/chat")!;
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import type { JobResult, JobRunner } from "../src/jobs/index.js";
import type { Report } from "../src/store.js";

const TZ = "America/New_York";

const DIGEST: Digest = {
  generatedAt: "2026-10-15T12:50:00Z",
  events: [
    { start: "2026-10-15T09:30:00-04:00", end: "2026-10-15T09:45:00-04:00", title: "Standup", calendar: "Work" },
    { start: "2026-10-15T12:30:00-04:00", end: "2026-10-15T13:30:00-04:00", title: "Lunch with Sam", location: "Joe's", calendar: "Personal" },
  ],
  inbox: [{ from: "Priya", subject: "Onboarding copy", line: "Wants a review by Thursday", receivedAt: "2026-10-15T10:58:00Z" }],
  skippedCount: 9,
  slack: [],
  tasksDue: [{ id: "t1", name: "Renew passport", status: "Open", source: "You", createdAt: "2026-10-10T00:00:00Z" }],
  sessionsWaiting: [{ job: "trip", status: "blocked", line: "TR-14 blocked: hotel budget cap?", at: "2026-10-15T02:00:00Z" }],
};

const REPORTS: Report[] = [
  // newest first, like Store.recentReports
  { jobId: "mk", text: "MK-74 merged ✅\nAll green.", receivedAt: "2026-10-15T03:10:00Z" }, // 23:10 EDT yesterday
  { jobId: "trip", text: "TR-14 blocked: hotel budget cap?", receivedAt: "2026-10-14T23:30:00Z" }, // 19:30 EDT yesterday
  { jobId: "old", text: "Yesterday afternoon's report", receivedAt: "2026-10-14T20:00:00Z" }, // 16:00 EDT yesterday
];

/** A stand-in chat brain: records each turn and answers at once. */
function fakeBrain() {
  const turns: { text: string; channel: BrainChannel; messageId?: string }[] = [];
  const brain: BriefBrain = {
    start(text: string, channel: BrainChannel, options: ChatOptions = {}) {
      const messageId = options.messageId ?? `m${turns.length}`;
      turns.push({ text, channel, messageId });
      options.onDelta?.("Good morning.");
      const done = Promise.resolve<BrainReply>({ messageId, reply: text.startsWith("[Morning brief") ? "Good morning. Standup at half nine." : "ok", metrics: {} as never });
      return { messageId, done };
    },
  };
  return { brain, turns };
}

/** A stand-in job runner holding one digest result; run() makes a fresh one. */
function fakeRunner(result?: JobResult<Digest>, fresh?: () => JobResult<Digest>) {
  let current = result;
  let runs = 0;
  const runner = {
    result: () => current,
    run: async () => {
      runs++;
      if (fresh) current = fresh();
      return current;
    },
  } as unknown as JobRunner;
  return { runner, runs: () => runs };
}

function setup(opts: { now: () => Date; runner?: JobRunner; reports?: Report[] }) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-brief-"));
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const { brain, turns } = fakeBrain();
  const jarvis = { store: { recentReports: () => opts.reports ?? REPORTS }, config: { dataDir: dir, timeZone: TZ } };
  const ctx = { jarvis, config: jarvis.config } as never;
  const brief = new BriefService({ ctx, brain, bus, runner: () => opts.runner, now: opts.now, suggestions: async () => 3, refreshWaitMs: 200 });
  useBrief(jarvis, brief);
  const desk = { jarvis, brain } as unknown as DeskContext;
  return { dir, brief, bus, events, turns, desk };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("overnight starts at 18:00 yesterday in Matthew's time zone", () => {
  assert.equal(overnightSince(new Date("2026-10-15T13:00:00Z"), TZ).toISOString(), "2026-10-14T22:00:00.000Z"); // EDT
  assert.equal(overnightSince(new Date("2026-12-15T14:00:00Z"), TZ).toISOString(), "2026-12-14T23:00:00.000Z"); // EST
  assert.equal(overnightSince(new Date("2026-10-15T08:00:00Z"), "Europe/London").toISOString(), "2026-10-14T17:00:00.000Z");
  assert.equal(dayIn(new Date("2026-10-15T03:00:00Z"), TZ), "2026-10-14", "23:00 in New York is still yesterday");
});

test("the brief prompt includes events, blocked sessions, overnight reports and suggestions from fixtures", async () => {
  const { runner } = fakeRunner({ at: "2026-10-15T12:50:00Z", data: DIGEST });
  const s = setup({ now: () => new Date("2026-10-15T13:00:00Z"), runner });
  const input = await s.brief.gather();
  const prompt = briefPrompt(input);
  assert.match(prompt, /^\[Morning brief: an instruction from JARVIS itself/, "instruction prefix");
  assert.match(prompt, /60 seconds/);
  assert.match(prompt, /no lists/);
  assert.match(prompt, /Thursday 15 October/);
  assert.match(prompt, /09:30–09:45 Standup/, "events in his time zone");
  assert.match(prompt, /12:30–13:30 Lunch with Sam \(Joe's\)/);
  assert.match(prompt, /trip \(blocked\): TR-14 blocked: hotel budget cap\?/);
  assert.match(prompt, /19:30 trip: TR-14 blocked/);
  assert.match(prompt, /23:10 mk: MK-74 merged ✅\n/, "first line of the report only");
  assert.ok(prompt.indexOf("19:30 trip") < prompt.indexOf("23:10 mk"), "oldest first");
  assert.doesNotMatch(prompt, /Yesterday afternoon/, "reports before 18:00 yesterday are left out");
  assert.match(prompt, /Renew passport/);
  assert.match(prompt, /Mail worth reading: 1 \(Priya: Wants a review by Thursday\)/);
  assert.match(prompt, /Suggested to-dos waiting for his review: 3\./);
});

test("a digest over 30 minutes old is refreshed before the brief", async () => {
  const old = { at: "2026-10-15T11:00:00Z", data: { ...DIGEST, events: [] } };
  const r = fakeRunner(old, () => ({ at: "2026-10-15T13:00:00Z", data: DIGEST }));
  const s = setup({ now: () => new Date("2026-10-15T13:00:00Z"), runner: r.runner });
  const input = await s.brief.gather();
  assert.equal(r.runs(), 1);
  assert.equal(input.digest?.events.length, 2);
  assert.equal(input.digestStale, false);

  // A fresh one isn't refreshed; no runner at all still gives a brief.
  await s.brief.gather();
  assert.equal(r.runs(), 1);
  const none = setup({ now: () => new Date("2026-10-15T13:00:00Z") });
  assert.match(briefPrompt(await none.brief.gather()), /calendar, mail and Slack: not available/);
});

test("POST /brief starts the brief in the conversation and publishes brief.ready", async () => {
  const { runner } = fakeRunner({ at: "2026-10-15T12:50:00Z", data: DIGEST });
  const s = setup({ now: () => new Date("2026-10-15T13:00:00Z"), runner });
  const res = (await briefRoute.handler({ body: {}, ctx: s.desk } as never)) as BriefResponse;
  await settle();
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].messageId, res.messageId, "the returned id is the brief's brain message");
  assert.equal(s.turns[0].channel, "desk-voice");
  assert.match(s.turns[0].text, /^\[Morning brief/);
  const ready = s.events.filter((e) => e.type === "brief.ready");
  assert.deepEqual(ready, [{ type: "brief.ready", messageId: res.messageId, text: "Good morning. Standup at half nine.", at: "2026-10-15T13:00:00.000Z" }]);
  assert.equal(s.brief.last.day, "2026-10-15");
});

test("fake clock: the first Desk voice turn after 05:00 gets the brief first, once a day; later turns don't", async () => {
  let now = new Date("2026-10-15T08:59:00Z"); // 04:59 EDT
  const { runner } = fakeRunner({ at: "2026-10-15T08:58:00Z", data: DIGEST });
  const s = setup({ now: () => now, runner });
  const voice = async (text: string, channel = "desk-voice") => {
    const res = (await chatRoute.handler({ body: { text, channel }, ctx: s.desk } as never)) as ChatResponse;
    await settle();
    return res;
  };

  await voice("what's the weather");
  assert.deepEqual(s.turns.map((t) => t.text), ["what's the weather"], "04:59: too early");

  now = new Date("2026-10-15T09:20:00Z"); // 05:20 EDT
  await voice("typed first", "desk-typed");
  assert.equal(s.turns.length, 2, "typed turns never trigger it");
  assert.equal(s.turns[1].text, "typed first");

  const first = await voice("start my day");
  assert.equal(s.turns.length, 4);
  assert.match(s.turns[2].text, /^\[Morning brief/, "the brief goes first");
  assert.equal(s.turns[3].text, "start my day", "then the request");
  assert.equal(s.turns[3].messageId, first.messageId, "the returned id is the request's");
  assert.equal(s.events.filter((e) => e.type === "brief.ready").length, 1);

  now = new Date("2026-10-15T13:00:00Z"); // 09:00
  await voice("and now?");
  assert.deepEqual(s.turns.slice(4).map((t) => t.text), ["and now?"], "later turns that day don't");

  now = new Date("2026-10-16T16:30:00Z"); // 12:30 next day
  await voice("lunch?");
  assert.deepEqual(s.turns.slice(5).map((t) => t.text), ["lunch?"], "after 12:00 there's no automatic brief");

  now = new Date("2026-10-17T03:30:00Z"); // 23:30 on the 16th in New York (already the 17th in UTC)
  assert.equal(s.brief.claimFirstTurn(), false);
  now = new Date("2026-10-17T10:00:00Z"); // 06:00 on the 17th
  await voice("morning");
  assert.match(s.turns[6].text, /^\[Morning brief/, "a new day, a new brief");
  assert.equal(s.turns[7].text, "morning");
});

test("a brief already given today (Play, Telegram) means no automatic one", async () => {
  const { runner } = fakeRunner({ at: "2026-10-15T12:50:00Z", data: DIGEST });
  const s = setup({ now: () => new Date("2026-10-15T13:00:00Z"), runner });
  await s.brief.start("telegram").done;
  assert.equal(s.brief.claimFirstTurn(), false);
  // The day survives a restart.
  const again = new BriefService({ ctx: { jarvis: {}, config: { dataDir: s.dir, timeZone: TZ } } as never, brain: fakeBrain().brain, now: () => new Date("2026-10-15T14:00:00Z") });
  assert.equal(again.claimFirstTurn(), false);
});
