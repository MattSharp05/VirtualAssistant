import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AcceptAllResponse, DeskEvent, TaskItem, TasksResponse } from "@jarvis/shared";
import type { Config } from "../src/config.js";
import taskRoutes from "../src/desk/routes/tasks.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { discoverJobs, JobRunner } from "../src/jobs/index.js";
import { MAX_SUGGESTIONS, validateSuggestions } from "../src/jobs/suggestions.js";
import { NotionApi, notionIdsFile } from "../src/notionWrite.js";
import { setupNotion } from "../src/setupNotion.js";
import { Store } from "../src/store.js";
import { Suggester } from "../src/suggest/index.js";
import { questionOf, sessionSuggestion } from "../src/suggest/sessions.js";
import { TasksService, useTasksService } from "../src/tasks.js";
import { ToolRegistry } from "../src/tools/index.js";
import tasksGroup from "../src/tools/tasks.js";
import { fakeNotion } from "./helpers/fakeNotion.js";

type Json = Record<string, unknown>;
const title = (text: string) => ({ type: "title", title: [{ plain_text: text }] });

/** JARVIS Tasks in a fake Notion, a Jarvis with it, and a Suggester (no network). */
async function setup(fetchWrap?: (inner: typeof fetch) => typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-suggest-"));
  const notion = fakeNotion();
  await setupNotion(new NotionApi("secret", notion.fetchImpl), notion.PARENT, notionIdsFile(dir));
  const fetchImpl = fetchWrap ? fetchWrap(notion.fetchImpl) : notion.fetchImpl;
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const svc = new TasksService(dir, "secret", bus, fetchImpl, () => new Date(2026, 9, 14, 9, 0));
  const store = new Store(dir);
  const jarvis = new Jarvis({ dataDir: dir, notionToken: "secret" } as Config, store);
  useTasksService(jarvis, svc);
  const ctx = { jarvis, config: jarvis.config };
  const suggester = new Suggester(ctx, fetchImpl);
  const tasksDb = notionIdsFile(dir).get().tasksDatabaseId!;
  /** Every row in JARVIS Tasks, any status, straight from the fake. */
  const rows = () => (notion.children.get(tasksDb) ?? []).map((id) => notion.objects.get(id)!);
  const prop = (row: Json, name: string) => ((row.properties as Json)[name] ?? {}) as Json;
  return { dir, notion, svc, store, jarvis, ctx, suggester, bus, events, rows, prop };
}

test("sessions: a blocked report makes exactly one Suggested task; a repeat (even at once) doesn't duplicate it", async () => {
  // start() also scans Notion QA: no Tickets databases shared here.
  const s = await setup((inner) => (async (url: string, init: RequestInit) =>
    url.endsWith("/search") ? new Response(JSON.stringify({ results: [], has_more: false })) : inner(url, init)) as typeof fetch);
  let every: { name: string; ms: number } | undefined;
  s.suggester.start((name, ms) => (every = { name, ms }));
  assert.deepEqual(every, { name: "suggestions", ms: 30 * 60_000 });

  s.store.addReport("trip", "⛔ TR-14 is blocked: which hotel budget cap should I use?", "session_01TRIP"); // on the report event
  await new Promise((r) => setTimeout(r, 50));
  const report = s.store.addReport("trip", "⛔ TR-14 is blocked: which hotel budget cap should I use?", "session_01TRIP");
  await Promise.all([s.suggester.fromReport(report), s.suggester.fromReport(report), s.suggester.sessions()]);
  await new Promise((r) => setTimeout(r, 50));

  const suggested = s.rows().filter((r) => (s.prop(r, "Status").select as Json).name === "Suggested");
  assert.equal(suggested.length, 1, "one row, however many times the report arrives");
  const [task] = await s.svc.list("suggested");
  assert.equal(task.name, "Decide TR-14: which hotel budget cap should I use?");
  assert.equal(task.source, "Session");
  assert.equal(task.sourceLink, "https://claude.ai/code/session_01TRIP");
  assert.match(task.why!, /trip is blocked/);
  assert.equal((s.prop(suggested[0], "Dedupe key").rich_text as Json[]).length, 1);
  assert.ok(s.events.some((e) => e.type === "tasks.changed"));

  // Plain progress reports suggest nothing.
  assert.deepEqual(await s.suggester.fromReport(s.store.addReport("mk", "MK-74 merged, CI green", "session_01MK")), []);
  assert.equal(questionOf("❓ MK-80 needs your decision: ship on Friday or Monday?", "MK-80"), "ship on Friday or Monday?");
  assert.equal(sessionSuggestion({ jobId: "mk", text: "Waiting on you: pick a logo", receivedAt: "" })?.dedupeKey, "session:mk:-");
});

test("dismissing a suggestion, then re-running every source, never recreates it", async () => {
  const s = await setup();
  const report = s.store.addReport("trip", "TR-14 needs a decision: hotel budget cap?", "session_01TRIP");
  assert.equal((await s.suggester.fromReport(report)).length, 1);
  const dismissed = await s.svc.dismiss("TR-14");
  assert.equal(dismissed.status, "Dismissed");
  assert.deepEqual(await s.svc.list("suggested"), []);

  assert.deepEqual(await s.suggester.fromReport(report), []);
  assert.deepEqual(await s.suggester.sessions(), []);
  assert.deepEqual(await s.suggester.fromReport(s.store.addReport("trip", "TR-14 needs a decision: hotel budget cap?", "session_01TRIP")), []);
  assert.equal(s.rows().length, 1, "still the one (Dismissed) row");
  assert.deepEqual(await s.svc.list("suggested"), []);
  await assert.rejects(s.svc.dismiss("TR-14"), /No suggestion matches/);
});

test("Notion QA: a suggestion per project with QA Pending tickets; Dismissed automatically when none remain", async () => {
  const PROJECT = "a1".padEnd(32, "0");
  const OTHER_PROJECT = "b2".padEnd(32, "0");
  const TICKETS = "c3".padEnd(32, "0");
  const OTHER_TICKETS = "d4".padEnd(32, "0");
  const tickets = [
    { n: 22, status: "QA Pending" },
    { n: 9, status: "QA Pending" },
    { n: 30, status: "In Progress" },
  ];
  const queries: Json[] = [];
  const s = await setup((inner) => (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.notion.com/v1", "");
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : {};
    const ok = (json: Json) => new Response(JSON.stringify(json), { status: 200 });
    const db = (id: string, parent: string, status: string) => ({ object: "database", id, title: [{ plain_text: "Tickets" }], parent: { type: "page_id", page_id: parent }, properties: { Status: { type: status } } });
    if (path === "/search") {
      return ok({
        results: [db(TICKETS, PROJECT, "select"), db(OTHER_TICKETS, OTHER_PROJECT, "status"), { object: "database", id: "e5".padEnd(32, "0"), title: [{ plain_text: "Epics" }], properties: { Status: {} } }],
        has_more: false,
      });
    }
    if (path === `/pages/${PROJECT}`) return ok({ object: "page", id: PROJECT, url: `https://www.notion.so/${PROJECT}`, properties: { title: title("JARVIS Desk") } });
    if (path === `/pages/${OTHER_PROJECT}`) return ok({ object: "page", id: OTHER_PROJECT, properties: { title: title("Trip") } });
    if (path === `/databases/${TICKETS}/query`) {
      queries.push(body.filter as Json);
      const want = (((body.filter as Json).select as Json).equals as string) ?? "";
      const results = tickets
        .filter((t) => t.status === want)
        .map((t) => ({ object: "page", id: `t${t.n}`, properties: { Title: title(`Ticket ${t.n}`), "Ticket ID": { type: "unique_id", unique_id: { prefix: "JD", number: t.n } } } }));
      return ok({ results, has_more: false });
    }
    if (path === `/databases/${OTHER_TICKETS}/query`) {
      queries.push(body.filter as Json);
      return ok({ results: [], has_more: false });
    }
    return inner(url, init);
  }) as typeof fetch);

  const first = await s.suggester.notionQa();
  assert.deepEqual(first.added.map((t) => t.name), ["QA JARVIS Desk batch (2 tickets)"], "Trip has none waiting, Epics isn't a Tickets database");
  assert.deepEqual(queries, [{ property: "Status", select: { equals: "QA Pending" } }, { property: "Status", status: { equals: "QA Pending" } }], "filters by each database's Status type");
  const [qa] = await s.svc.list("suggested");
  assert.equal(qa.source, "Notion QA");
  assert.equal(qa.project, "JARVIS Desk");
  assert.equal(qa.sourceLink, `https://www.notion.so/${PROJECT}`);
  assert.equal(qa.why, "JD-9, JD-22 are waiting for your QA in JARVIS Desk.");
  assert.deepEqual((await s.suggester.notionQa()).added, [], "same batch: no duplicate");

  // Matthew finishes QA: nothing pending → the suggestion goes away by itself.
  for (const t of tickets) t.status = "Done";
  const after = await s.suggester.notionQa();
  assert.deepEqual(after.dismissed.map((t) => [t.name, t.status]), [["QA JARVIS Desk batch (2 tickets)", "Dismissed"]]);
  assert.deepEqual(await s.svc.list("suggested"), []);

  // A new batch is a new suggestion; an accepted one is left alone when its batch ends.
  tickets.push({ n: 31, status: "QA Pending" });
  const next = await s.suggester.notionQa();
  assert.deepEqual(next.added.map((t) => t.name), ["QA JARVIS Desk batch (1 ticket)"]);
  await s.svc.accept("QA JARVIS Desk");
  tickets[3].status = "Done";
  assert.deepEqual((await s.suggester.notionQa()).dismissed, []);
  assert.deepEqual((await s.svc.list("project")).map((t) => t.name), ["QA JARVIS Desk batch (1 ticket)"]);
});

test("Slack/email (fake worker): at most 5 per run, each with a link and a reason; deduped by link", async () => {
  const s = await setup();
  const asks = Array.from({ length: 7 }, (_, n) => ({
    name: `Reply to ask ${n}`,
    source: n % 2 ? "Email" : "Slack",
    link: `https://gogentic.slack.com/archives/D01/p17000000${n}`,
    why: `Person ${n} asked for a reply this morning`,
  }));
  let payload: unknown = { suggestions: asks };
  const worker = { chat: async () => runner.submit("suggestions", payload), reset: () => undefined };
  const runner: JobRunner = new JobRunner(await discoverJobs(), worker, s.ctx, { dataDir: s.dir, timeoutMs: 2_000 });
  assert.ok(runner.submitToolNames.includes("suggest_task"));
  assert.ok((await ToolRegistry.discover()).list().some((t) => t.name === "suggest_task"), "served by the MCP server for the worker");

  const result = (await runner.run("suggestions"))!.data as { added: TaskItem[]; offered: number };
  assert.equal(result.offered, MAX_SUGGESTIONS);
  assert.equal(result.added.length, MAX_SUGGESTIONS);
  const suggested = await s.svc.list("suggested");
  assert.equal(suggested.length, 5);
  for (const t of suggested) {
    assert.match(t.sourceLink ?? "", /^https:\/\/gogentic\.slack\.com\//);
    assert.match(t.why ?? "", /asked for a reply/);
    assert.ok(t.source === "Slack" || t.source === "Email");
  }
  const row = s.rows()[0];
  assert.equal(s.prop(row, "Dedupe key").rich_text && ((s.prop(row, "Dedupe key").rich_text as Json[])[0].text as Json).content, asks[0].link, "dedupe = message link");

  // Next run: the same five are skipped, the two left over get in.
  payload = { suggestions: asks.slice(3) };
  const second = (await runner.run("suggestions"))!.data as { added: TaskItem[] };
  assert.deepEqual(second.added.map((t) => t.name), ["Reply to ask 5", "Reply to ask 6"]);

  assert.throws(() => validateSuggestions({ suggestions: [{ name: "Reply", source: "Slack", why: "asked" }] }), /suggestions\[0\]\.link is required/);
  assert.throws(() => validateSuggestions({ suggestions: [{ name: "Reply", source: "Slack", link: "https://x" }] }), /suggestions\[0\]\.why is required/);
  assert.throws(() => validateSuggestions({ suggestions: [{ name: "Reply", source: "Teams", link: "https://x", why: "y" }] }), /Slack or Email/);
  assert.deepEqual(validateSuggestions({ suggestions: [] }), []);
});

test("accept / dismiss: tools for voice and Telegram, Desk routes", async () => {
  const s = await setup();
  const add = (name: string, n: number) => s.suggester.add([{ name, source: "Email", link: `https://mail.google.com/mail/u/0/#inbox/${n}`, dedupeKey: `mail-${n}`, why: `Asked ${n}` }]);
  await add("Send passport scan to the travel agent", 1);
  await add("Reply to Sam about lunch", 2);
  await add("Review Priya's onboarding copy", 3);
  await add("Confirm dentist appointment", 4);
  await s.svc.add({ name: "Renew passport" }); // an Open task with a similar name doesn't get in the way
  const tool = (name: string) => tasksGroup.tools.find((t) => t.name === name)!;

  assert.match(await tool("list_tasks").handler({ when: "suggested" }, s.ctx), /4 tasks[\s\S]*Send passport scan to the travel agent \(Suggested\) from Email: Asked 1/);
  assert.match(await tool("accept_suggestion").handler({ task: "passport" }, s.ctx), /Added: Send passport scan to the travel agent/);
  assert.equal((await s.svc.find("passport scan")).status, "Open");
  assert.match(await tool("dismiss_suggestion").handler({ task: "sam" }, s.ctx), /Dismissed: Reply to Sam about lunch/);
  await assert.rejects(tool("accept_suggestion").handler({ task: "Renew passport" }, s.ctx), /No suggestion matches/);

  const deskCtx = { jarvis: s.jarvis, bus: s.bus } as unknown as DeskContext;
  const route = (path: string) => taskRoutes.find((r) => r.path === path)!;
  const call = (path: string, extra: Json) => route(path).handler({ ctx: deskCtx, params: {}, body: {}, ...extra } as never);
  const view = (await call("/tasks", { url: new URL("http://x/api/desk/tasks?view=suggested") })) as TasksResponse;
  assert.deepEqual(view.tasks.map((t) => [t.name, t.why]), [["Review Priya's onboarding copy", "Asked 3"], ["Confirm dentist appointment", "Asked 4"]]);
  const accepted = (await call("/tasks/:id/accept", { params: { id: view.tasks[0].id } })) as TaskItem;
  assert.equal(accepted.status, "Open");
  await assert.rejects(Promise.resolve().then(() => call("/tasks/:id/dismiss", { params: { id: view.tasks[0].id } })), (e: Error & { status?: number }) => e.status === 400, "not a suggestion any more");
  await add("Pay the invoice", 5);
  const all = (await call("/tasks/accept-all", {})) as AcceptAllResponse;
  assert.deepEqual(all.accepted.map((t) => t.status), ["Open", "Open"]);
  assert.match(await tool("accept_suggestion").handler({ task: "all" }, s.ctx), /No suggestions waiting/);
  assert.deepEqual(((await call("/tasks", { url: new URL("http://x/?view=suggested") })) as TasksResponse).tasks, []);
});
