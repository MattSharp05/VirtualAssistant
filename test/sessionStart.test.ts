import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionBody } from "../src/cloud.js";
import type { Config } from "../src/config.js";
import { mergeSessions } from "../src/desk/routes/sessions.js";
import { Jarvis } from "../src/jarvis.js";
import { loadWorkerInstructions, sessionPromptText } from "../src/prompts.js";
import { planSession, repoUrlOf, sessionTags, SessionStarter, type StarterDeps } from "../src/sessionStart.js";
import {
  deriveTitleRole,
  fallbackSummary,
  finishSummary,
  MAX_SUMMARY,
  MAX_TITLE,
  sessionDisplayTitle,
  summaryFor,
  ticketIdIn,
  writeTitle,
} from "../src/sessionTitle.js";
import { Store } from "../src/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-start-"));

const PROJECTS = [
  { slug: "jarvis", name: "JARVIS Desk", repo: "MattSharp05/VirtualAssistant", prefix: "JD" },
  { slug: "trip", name: "Trip planner", repo: "MattSharp05/trip", prefix: "TP" },
];

function config(dir: string, over: Partial<Config> = {}): Config {
  return {
    dataDir: dir,
    claudeBin: "/bin/false",
    projects: PROJECTS,
    defaultRepo: "https://github.com/MattSharp05/VirtualAssistant",
    sessionEnvironmentId: "env_01TEST",
    ...over,
  } as unknown as Config;
}

/** A claude.ai login in a temp config folder (the API's bearer token). */
function loginDir(): string {
  const dir = tmp();
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-test" } }));
  return dir;
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fake fetch: answers each call with the next response, records what was sent. */
function fakeFetch(...responses: (Response | Error)[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : {}, headers: init.headers as Record<string, string> });
    const next = responses.shift() ?? new Response("{}", { status: 500 });
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const created = (id = "session_01NEW") => new Response(JSON.stringify({ id, title: "x", session_status: "SESSION_STATUS_PENDING" }), { status: 200 });

// ── Repo, project, role and tags ──

test("planSession: the default repo and its project, role:task + titleRole:orchestrator for a plain task", () => {
  const plan = planSession("Tidy the README", config(tmp()));
  assert.deepEqual(plan, { repoUrl: "https://github.com/MattSharp05/VirtualAssistant", project: "jarvis", projectName: "JARVIS Desk", role: "task", titleRole: "orchestrator" });
  assert.deepEqual(sessionTags(plan, "j11"), ["project:jarvis", "role:task", "jarvis:j11"]);
});

test("planSession: a project the task names picks its repo (\"in trip\", \"trip: …\", the project's name)", () => {
  for (const task of ["Add a packing list in trip", "trip: add a packing list", "Add a packing list for the Trip planner"]) {
    const plan = planSession(task, config(tmp()));
    assert.equal(plan.repoUrl, "https://github.com/MattSharp05/trip", task);
    assert.equal(plan.project, "trip", task);
    assert.equal(plan.projectName, "Trip planner", task);
  }
  assert.equal(planSession("Plan a trip to Rome", config(tmp())).project, "jarvis", "a bare word isn't a project mention");
});

test("planSession: a ticket ID makes a builder (role + titleRole) and picks its project by prefix", () => {
  const plan = planSession("Build tp-12, the packing list", config(tmp()));
  assert.deepEqual(plan, { repoUrl: "https://github.com/MattSharp05/trip", project: "trip", projectName: "Trip planner", ticket: "TP-12", role: "builder", titleRole: "builder" });
  assert.deepEqual(sessionTags(plan, "j3"), ["project:trip", "role:builder", "jarvis:j3", "ticket:TP-12"]);
});

test("planSession: a GitHub URL in the task wins; without PROJECTS the repo name is the project (no display name)", () => {
  const plan = planSession("Fix the build in https://github.com/acme/widgets please", config(tmp(), { projects: [] }));
  assert.deepEqual(plan, { repoUrl: "https://github.com/acme/widgets", project: "widgets", role: "task", titleRole: "orchestrator" }, "no ticket, so no builder even though \"Fix\" is a build word");
  assert.equal(planSession("Fix AB-7", config(tmp(), { projects: [] })).ticket, "AB-7", "any upper-case ID counts without prefixes");
  assert.deepEqual(planSession("Do a thing", config(tmp(), { projects: [], defaultRepo: undefined })), { role: "task", titleRole: "orchestrator" });
  assert.equal(repoUrlOf("MattSharp05/trip"), "https://github.com/MattSharp05/trip");
  assert.equal(repoUrlOf("https://github.com/MattSharp05/trip.git/"), "https://github.com/MattSharp05/trip");
});

// ── Title role (JD-81: the role word in a session's display title) ──

test("deriveTitleRole: builder for a ticket being built, design/scoping for PRD or research work, orchestrator otherwise", () => {
  assert.equal(deriveTitleRole("Build JD-80, the Today digest", "JD-80"), "builder");
  assert.equal(deriveTitleRole("Fix the clock", undefined), "orchestrator", "a build word alone, with no ticket, isn't a builder");
  assert.equal(deriveTitleRole("Write the PRD for the next feature", undefined), "design");
  assert.equal(deriveTitleRole("Figure out where the naming rule should live", undefined), "scoping");
  assert.equal(deriveTitleRole("Figure out where the rule lives and implement it", undefined), "orchestrator", "scoping language plus a build word is an orchestrator, not scoping");
  assert.equal(deriveTitleRole("Reply to Matthew's question", undefined), "orchestrator");
});

// ── Titles ──

test("ticketIdIn: only the configured prefixes count when there are some", () => {
  assert.equal(ticketIdIn("look at jd-65 please", ["JD"]), "JD-65");
  assert.equal(ticketIdIn("UTF-8 handling", ["JD"]), undefined);
  assert.equal(ticketIdIn("UTF-8 handling"), "UTF-8", "without prefixes any upper-case ID");
  assert.equal(ticketIdIn("utf-8 handling"), undefined);
});

test("finishSummary: tidies the model's answer, lower case, stays within MAX_SUMMARY", () => {
  assert.equal(finishSummary('"Fixing Today window timezone."'), "fixing Today window timezone");
  assert.equal(finishSummary("Summary: adding a packing list\nmore text"), "adding a packing list");
  const long = finishSummary("Refactoring the calendar window so that every event shows its attendees and location in full");
  assert.ok(long.length <= MAX_SUMMARY, long);
  assert.doesNotMatch(long, /\s$/);
});

test("fallbackSummary: the task's first words, lower case, without the pleasantries or the ticket", () => {
  assert.equal(fallbackSummary("please can you fix the Today window's timezone?"), "fix the Today window's timezone");
  assert.equal(fallbackSummary("JD-65 finish the sign-in flow\nmore detail here", "JD-65"), "finish the sign-in flow");
  assert.ok(fallbackSummary("x ".repeat(80)).length <= MAX_SUMMARY);
});

test("summaryFor: the written summary, else the first words when the call fails, says nothing useful, or just echoes the ticket", async () => {
  assert.equal(await summaryFor("fix the clock", undefined, async () => "Fixing the Today clock"), "fixing the Today clock");
  assert.equal(await summaryFor("fix the clock", undefined, async () => undefined), "fix the clock");
  assert.equal(await summaryFor("fix the clock", undefined, async () => Promise.reject(new Error("down"))), "fix the clock");
  assert.equal(await summaryFor("JD-9 fix the clock", "JD-9", async () => "JD-9"), "fix the clock", "an ID alone isn't a summary");
});

test("sessionDisplayTitle: \"J<n> · Project - summary (role)\", a generic project name when none is known, clipped to fit", () => {
  assert.equal(sessionDisplayTitle("j17", "JARVIS Desk", "adding session naming rule", "orchestrator"), "J17 · JARVIS Desk - adding session naming rule (orchestrator)");
  assert.equal(sessionDisplayTitle("j1", undefined, "fix the clock", "orchestrator"), "J1 · JARVIS - fix the clock (orchestrator)");
  const long = sessionDisplayTitle("j2", "JARVIS Desk", "x ".repeat(40).trim(), "builder");
  assert.ok(long.length <= MAX_TITLE, long);
  assert.match(long, /\(builder\)$/);
});

test("writeTitle: one short CLI call on the worker model with no tools; failures give undefined", async () => {
  const dir = tmp();
  const bin = join(dir, "claude");
  const log = join(dir, "log");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\ncat >> ${log}\necho '{"type":"result","result":"Fixing the Today clock","is_error":false}'\n`);
  chmodSync(bin, 0o755);
  assert.equal(await writeTitle(bin, "claude-haiku-5-5", "fix the clock", dir), "Fixing the Today clock");
  const argv = readFileSync(log, "utf8");
  assert.match(argv, /^-p\n--model\nclaude-haiku-5-5\n/);
  assert.match(argv, /--tools\n\n--strict-mcp-config/);
  assert.match(argv, /Task:\nfix the clock/, "the task goes in on stdin");
  assert.equal(await writeTitle("/bin/false", undefined, "x", dir), undefined);
  assert.equal(await writeTitle(join(dir, "missing"), undefined, "x", dir), undefined);
});

// ── The worker instructions ──

test("the worker instructions come from docs/routine-prompt.md and lead the first message", () => {
  const instructions = loadWorkerInstructions();
  assert.match(instructions, /^You are a JARVIS worker/);
  assert.doesNotMatch(instructions, /Paste everything below/);
  const text = sessionPromptText(instructions, "j4", "Fix the clock", new Date("2026-10-19T10:00:00Z"));
  assert.ok(text.startsWith(instructions));
  assert.match(text, /JARVIS job: j4\nSent at: 2026-10-19T10:00:00.000Z\n\nTask from Matthew:\nFix the clock$/);
  const missing = loadWorkerInstructions(join(tmp(), "nope.md"));
  assert.match(missing, /scripts\/report\.sh/, "a built-in copy when the file is missing");
});

test("createSessionBody: title, environment, repo source, tags and the first message", () => {
  const body = createSessionBody({ title: "Fix it", prompt: "hello", repoUrl: "https://github.com/a/b", environmentId: "env_1", tags: ["role:task"] });
  assert.equal(body.title, "Fix it");
  assert.equal(body.environment_id, "env_1");
  assert.deepEqual(body.session_context, { sources: [{ git_repository: { url: "https://github.com/a/b" } }] });
  assert.deepEqual(body.tags, ["role:task"]);
  const events = body.events as { data: { type: string; message: { role: string; content: string } } }[];
  assert.deepEqual(events[0].data.message, { role: "user", content: "hello" });
  const bare = createSessionBody({ title: "Fix it", tags: [] });
  assert.equal("events" in bare || "environment_id" in bare, false, "no first message, and the API picks the environment");
});

// ── Starting ──

function starter(dir: string, deps: StarterDeps, over: Partial<Config> = {}): SessionStarter {
  return new SessionStarter(config(dir, over), { instructions: "WORKER RULES", writeSummary: async () => "Fixing the Today clock", log: () => {}, ...deps });
}

test("start: one POST to the sessions API makes a titled, tagged session on the right repo", async () => {
  const { fetchImpl, calls } = fakeFetch(created());
  const s = await starter(tmp(), { fetchImpl, configDir: loginDir() }).start("j7", "JD-60 fix the clock", new Date("2026-10-19T10:00:00Z"));
  assert.deepEqual(s, {
    sessionId: "session_01NEW",
    url: "https://claude.ai/code/session_01NEW",
    title: "J7 · JARVIS Desk - fixing the Today clock (builder)",
    tags: ["project:jarvis", "role:builder", "jarvis:j7", "ticket:JD-60"],
    via: "api",
    repoUrl: "https://github.com/MattSharp05/VirtualAssistant",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/code/sessions");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, "Bearer tok-test");
  assert.equal(calls[0].body.title, "J7 · JARVIS Desk - fixing the Today clock (builder)");
  assert.equal(calls[0].body.environment_id, "env_01TEST");
  const content = (calls[0].body.events as { data: { message: { content: string } } }[])[0].data.message.content;
  assert.match(content, /^WORKER RULES\n\n---\n\nJARVIS job: j7\n/);
  assert.match(content, /Task from Matthew:\nJD-60 fix the clock$/);
});

test("start: when the API refuses the first message, the session is created bare and the task sent with the CLI", async () => {
  const { fetchImpl, calls } = fakeFetch(new Response('{"error":"unknown field events"}', { status: 400 }), created("session_01BARE"));
  const sent: { id: string; message: string }[] = [];
  const s = await starter(tmp(), { fetchImpl, configDir: loginDir(), send: async (_bin, id, message) => (sent.push({ id, message }), { ok: true }) }).start("j8", "fix the clock", new Date());
  assert.equal(s.via, "api+cli");
  assert.equal(s.sessionId, "session_01BARE");
  assert.equal(calls.length, 2);
  assert.equal("events" in calls[1].body, false);
  assert.equal(calls[1].body.title, "J8 · JARVIS Desk - fixing the Today clock (orchestrator)");
  assert.equal(sent[0].id, "session_01BARE");
  assert.match(sent[0].message, /^WORKER RULES[\s\S]*JARVIS job: j8/);
});

test("start: no login fails at once, without spending a title call", async () => {
  let titled = 0;
  const { fetchImpl, calls } = fakeFetch();
  await assert.rejects(
    starter(tmp(), { fetchImpl, configDir: tmp(), writeSummary: async () => (titled++, "x") }).start("j1", "x", new Date()),
    /no claude\.ai login/,
  );
  assert.equal(titled, 0);
  assert.equal(calls.length, 0);
});

// ── Jarvis.startJob: the routine is the fallback only ──

function jarvisWith(fetchImpl: typeof fetch, configDir: string, over: Partial<Config> = {}): Jarvis {
  const dir = tmp();
  const jarvis = new Jarvis(config(dir, over), new Store(dir));
  jarvis.api = { fetchImpl, configDir };
  jarvis.starter = starter(dir, { fetchImpl, configDir }, over);
  return jarvis;
}

test("startJob: a direct session uses no routine fire, and JARVIS finds it by job name", async () => {
  const { fetchImpl } = fakeFetch(created("session_01J1"));
  const jarvis = jarvisWith(fetchImpl, loginDir(), { routineId: "trig_1", routineToken: "t" });
  const { job, via, fireNumber } = await jarvis.startJob("fix the clock");
  assert.equal(via, "api");
  assert.equal(fireNumber, undefined);
  assert.equal(job.id, "j1");
  assert.deepEqual(
    { via: job.via, title: job.title, tags: job.tags },
    { via: "api", title: "J1 · JARVIS Desk - fixing the Today clock (orchestrator)", tags: ["project:jarvis", "role:task", "jarvis:j1"] },
  );
  assert.equal(jarvis.store.firesInLastHour().length, 0, "no hourly routine cap applies");
  assert.equal(jarvis.store.findBySession("session_01J1")?.id, "j1");
  // The Sessions window: the cloud row (its new title) carries the job name.
  const [row] = mergeSessions([{ id: "session_01J1", title: job.title!, url: job.url }], jarvis.store.recentJobs(10), []);
  assert.deepEqual({ id: row.id, name: row.name, title: row.title }, { id: "j1", name: "j1", title: "J1 · JARVIS Desk - fixing the Today clock (orchestrator)" });
});

test("startJob: the API failing falls back to the routine (one fire) and renames it right away; no fallback is a clear error", async () => {
  const routine = new Response(JSON.stringify({ claude_code_session_id: "session_01R", claude_code_session_url: "https://claude.ai/code/session_01R" }), { status: 200 });
  const { fetchImpl, calls } = fakeFetch(new Response("{}", { status: 503 }), routine, new Response("{}", { status: 200 }));
  const jarvis = jarvisWith(fetchImpl, loginDir(), { routineId: "trig_1", routineToken: "t" });
  const { job, via, fireNumber } = await jarvis.startJob("fix the clock");
  assert.deepEqual({ via, fireNumber, jobVia: job.via, sessionId: job.sessionId }, { via: "routine", fireNumber: 1, jobVia: "routine", sessionId: "session_01R" });
  assert.match(calls[1].url, /routines\/trig_1\/fire$/);
  assert.equal(jarvis.store.firesInLastHour().length, 1);
  // The routines-fire API can't set a title, so JARVIS renames the real session right after firing it.
  assert.equal(calls.length, 3);
  assert.equal(calls[2].method, "PATCH");
  assert.equal(calls[2].body.title, "J1 · JARVIS Desk - fixing the Today clock (orchestrator)");
  assert.equal(job.title, "J1 · JARVIS Desk - fixing the Today clock (orchestrator)");

  const none = jarvisWith(fakeFetch().fetchImpl, tmp());
  await assert.rejects(none.startJob("x"), /no claude\.ai login found.*\. No routine configured as a fallback/);
});

test("startJob: when the post-fire rename fails, the job stays untitled so renameRoutineSessions retries it later", async () => {
  const routine = new Response(JSON.stringify({ claude_code_session_id: "session_01R", claude_code_session_url: "https://claude.ai/code/session_01R" }), { status: 200 });
  const { fetchImpl } = fakeFetch(new Response("{}", { status: 503 }), routine, new Response("nope", { status: 404 }));
  const jarvis = jarvisWith(fetchImpl, loginDir(), { routineId: "trig_1", routineToken: "t" });
  const { job } = await jarvis.startJob("fix the clock");
  assert.equal(job.title, undefined);
  assert.equal(jarvis.store.getJob(job.id)?.title, undefined);
});

test("renameRoutineSessions: titles older routine sessions where the API allows, once", async () => {
  const { fetchImpl, calls } = fakeFetch(new Response("{}", { status: 200 }), new Response("nope", { status: 404 }));
  const jarvis = jarvisWith(fetchImpl, loginDir());
  const old = (id: string, sessionId: string) => ({ id, sessionId, url: `https://claude.ai/code/${sessionId}`, task: "fix the clock", createdAt: new Date().toISOString(), kind: "started" as const });
  jarvis.store.addJob(old("j1", "session_01A"));
  jarvis.store.addJob(old("j2", "session_01B"));
  jarvis.store.addJob({ ...old("j3", "session_01C"), via: "api", title: "Already named" });
  jarvis.store.addJob({ ...old("mk", "session_01D"), kind: "attached" });
  const { renamed, failed } = await jarvis.renameRoutineSessions();
  assert.equal(calls.length, 2, "only the two routine sessions");
  assert.ok(calls.every((c) => c.method === "PATCH"));
  assert.equal(calls[0].body.title, "J1 · JARVIS Desk - fixing the Today clock (orchestrator)");
  assert.equal(calls[1].body.title, "J2 · JARVIS Desk - fixing the Today clock (orchestrator)");
  assert.equal(renamed.length, 1);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /HTTP 404/);
  const done = renamed[0].id;
  assert.equal(done, "j1");
  assert.equal(jarvis.store.getJob(done)?.title, "J1 · JARVIS Desk - fixing the Today clock (orchestrator)");
  const again = await jarvis.renameRoutineSessions();
  assert.equal(again.renamed.length + again.failed.length, 1, "the renamed one isn't tried again");
});

test("writeTitle runs in its own empty working folder under DATA_DIR", async () => {
  const dir = join(tmp(), "data");
  await writeTitle("/bin/false", undefined, "x", dir);
  assert.ok(existsSync(join(dir, "titles")));
});
