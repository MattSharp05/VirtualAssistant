import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionBody } from "../src/cloud.js";
import { parseProjects, type Config } from "../src/config.js";
import { mergeSessions } from "../src/desk/routes/sessions.js";
import { Jarvis } from "../src/jarvis.js";
import { loadWorkerInstructions, sessionPromptText } from "../src/prompts.js";
import { describeProjects, findProject, planSession, repoUrlOf, sessionTags, SessionStarter, type StarterDeps } from "../src/sessionStart.js";
import sessionsGroup from "../src/tools/sessions.js";
import type { ToolContext } from "../src/tools/types.js";
import { fallbackTitle, finishTitle, MAX_TITLE, ticketIdIn, titleFor, writeTitle } from "../src/sessionTitle.js";
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

test("planSession: the default repo and its project, role:task for a plain task", () => {
  const plan = planSession("Tidy the README", config(tmp()));
  assert.deepEqual(plan, {
    repoUrl: "https://github.com/MattSharp05/VirtualAssistant",
    project: "jarvis",
    projectName: "JARVIS Desk",
    role: "task",
    environmentId: "env_01TEST",
    routineFallback: true,
  });
  assert.deepEqual(sessionTags(plan, "j11"), ["project:jarvis", "role:task", "jarvis:j11"]);
});

test("planSession: a project the task names picks its repo (\"in trip\", \"trip: …\", the project's name)", () => {
  for (const task of ["Add a packing list in trip", "trip: add a packing list", "Add a packing list for the Trip planner"]) {
    const plan = planSession(task, config(tmp()));
    assert.equal(plan.repoUrl, "https://github.com/MattSharp05/trip", task);
    assert.equal(plan.project, "trip", task);
  }
  assert.equal(planSession("Plan a trip to Rome", config(tmp())).project, "jarvis", "a bare word isn't a project mention");
});

test("planSession: a ticket ID makes a builder and picks its project by prefix", () => {
  const plan = planSession("Build tp-12, the packing list", config(tmp()));
  assert.deepEqual(plan, {
    repoUrl: "https://github.com/MattSharp05/trip",
    project: "trip",
    projectName: "Trip planner",
    ticket: "TP-12",
    role: "builder",
    environmentId: "env_01TEST",
    routineFallback: false,
  });
  assert.deepEqual(sessionTags(plan, "j3"), ["project:trip", "role:builder", "jarvis:j3", "ticket:TP-12"]);
});

test("planSession: a GitHub URL in the task wins; without PROJECTS the repo name is the project", () => {
  const plan = planSession("Fix the build in https://github.com/acme/widgets please", config(tmp(), { projects: [] }));
  assert.deepEqual(plan, { repoUrl: "https://github.com/acme/widgets", project: "widgets", role: "task", environmentId: "env_01TEST", routineFallback: false });
  assert.equal(planSession("Fix AB-7", config(tmp(), { projects: [] })).ticket, "AB-7", "any upper-case ID counts without prefixes");
  assert.deepEqual(planSession("Do a thing", config(tmp(), { projects: [], defaultRepo: undefined, sessionEnvironmentId: undefined })), { role: "task", routineFallback: true });
  assert.equal(repoUrlOf("MattSharp05/trip"), "https://github.com/MattSharp05/trip");
  assert.equal(repoUrlOf("https://github.com/MattSharp05/trip.git/"), "https://github.com/MattSharp05/trip");
});

// ── Titles ──

test("ticketIdIn: only the configured prefixes count when there are some", () => {
  assert.equal(ticketIdIn("look at jd-65 please", ["JD"]), "JD-65");
  assert.equal(ticketIdIn("UTF-8 handling", ["JD"]), undefined);
  assert.equal(ticketIdIn("UTF-8 handling"), "UTF-8", "without prefixes any upper-case ID");
  assert.equal(ticketIdIn("utf-8 handling"), undefined);
});

test("finishTitle: tidies the model's answer, puts the ticket first, stays within 60 characters", () => {
  assert.equal(finishTitle('"Fix Today window timezone."'), "Fix Today window timezone");
  assert.equal(finishTitle("Title: fix sign-in\nmore text", "JD-65"), "JD-65: Fix sign-in");
  assert.equal(finishTitle("JD-65: Fix sign-in", "JD-65"), "JD-65: Fix sign-in", "no doubled ID");
  const long = finishTitle("Refactor the calendar window so that every event shows its attendees and location", "JD-70");
  assert.ok(long.length <= MAX_TITLE, long);
  assert.match(long, /^JD-70: Refactor the calendar window/);
  assert.doesNotMatch(long, /\s$/);
});

test("fallbackTitle: the task's first words, without the pleasantries", () => {
  assert.equal(fallbackTitle("please can you fix the Today window's timezone?"), "Fix the Today window's timezone");
  assert.equal(fallbackTitle("JD-65 finish the sign-in flow\nmore detail here", "JD-65"), "JD-65: Finish the sign-in flow");
  assert.ok(fallbackTitle("x ".repeat(80)).length <= MAX_TITLE);
});

test("titleFor: the written title, else the first words when the call fails or says nothing useful", async () => {
  assert.equal(await titleFor("fix the clock", undefined, async () => "Fix the Today clock"), "Fix the Today clock");
  assert.equal(await titleFor("fix the clock", undefined, async () => undefined), "Fix the clock");
  assert.equal(await titleFor("fix the clock", undefined, async () => Promise.reject(new Error("down"))), "Fix the clock");
  assert.equal(await titleFor("JD-9 fix the clock", "JD-9", async () => "JD-9"), "JD-9: Fix the clock", "an ID alone isn't a title");
});

test("writeTitle: one short CLI call on the worker model with no tools; failures give undefined", async () => {
  const dir = tmp();
  const bin = join(dir, "claude");
  const log = join(dir, "log");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\ncat >> ${log}\necho '{"type":"result","result":"Fix the Today clock","is_error":false}'\n`);
  chmodSync(bin, 0o755);
  assert.equal(await writeTitle(bin, "claude-haiku-5-5", "fix the clock", dir), "Fix the Today clock");
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
  return new SessionStarter(config(dir, over), { instructions: "WORKER RULES", writeTitle: async () => "Fix the Today clock", log: () => {}, ...deps });
}

test("start: one POST to the sessions API makes a titled, tagged session on the right repo", async () => {
  const { fetchImpl, calls } = fakeFetch(created());
  const s = await starter(tmp(), { fetchImpl, configDir: loginDir() }).start("j7", "JD-60 fix the clock", new Date("2026-10-19T10:00:00Z"));
  assert.deepEqual(s, {
    sessionId: "session_01NEW",
    url: "https://claude.ai/code/session_01NEW",
    title: "JD-60: Fix the Today clock",
    tags: ["project:jarvis", "role:builder", "jarvis:j7", "ticket:JD-60"],
    via: "api",
    repoUrl: "https://github.com/MattSharp05/VirtualAssistant",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/code/sessions");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, "Bearer tok-test");
  assert.equal(calls[0].body.title, "JD-60: Fix the Today clock");
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
  assert.equal(calls[1].body.title, "Fix the Today clock");
  assert.equal(sent[0].id, "session_01BARE");
  assert.match(sent[0].message, /^WORKER RULES[\s\S]*JARVIS job: j8/);
});

test("start: no login fails at once, without spending a title call", async () => {
  let titled = 0;
  const { fetchImpl, calls } = fakeFetch();
  await assert.rejects(
    starter(tmp(), { fetchImpl, configDir: tmp(), writeTitle: async () => (titled++, "x") }).start("j1", "x", new Date()),
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
  assert.deepEqual({ via: job.via, title: job.title, tags: job.tags }, { via: "api", title: "Fix the Today clock", tags: ["project:jarvis", "role:task", "jarvis:j1"] });
  assert.equal(jarvis.store.firesInLastHour().length, 0, "no hourly routine cap applies");
  assert.equal(jarvis.store.findBySession("session_01J1")?.id, "j1");
  // The Sessions window: the cloud row (its new title) carries the job name.
  const [row] = mergeSessions([{ id: "session_01J1", title: "Fix the Today clock", url: job.url }], jarvis.store.recentJobs(10), []);
  assert.deepEqual({ id: row.id, name: row.name, title: row.title }, { id: "j1", name: "j1", title: "Fix the Today clock" });
});

test("startJob: the API failing falls back to the routine (one fire), and no fallback is a clear error", async () => {
  const routine = new Response(JSON.stringify({ claude_code_session_id: "session_01R", claude_code_session_url: "https://claude.ai/code/session_01R" }), { status: 200 });
  const { fetchImpl, calls } = fakeFetch(new Response("{}", { status: 503 }), routine);
  const jarvis = jarvisWith(fetchImpl, loginDir(), { routineId: "trig_1", routineToken: "t" });
  const { job, via, fireNumber } = await jarvis.startJob("fix the clock");
  assert.deepEqual({ via, fireNumber, jobVia: job.via, sessionId: job.sessionId }, { via: "routine", fireNumber: 1, jobVia: "routine", sessionId: "session_01R" });
  assert.match(calls[1].url, /routines\/trig_1\/fire$/);
  assert.equal(jarvis.store.firesInLastHour().length, 1);

  const none = jarvisWith(fakeFetch().fetchImpl, tmp());
  await assert.rejects(none.startJob("x"), /no claude\.ai login found.*\. No routine configured as a fallback/);
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
  assert.ok(calls.every((c) => c.method === "PATCH" && c.body.title === "Fix the Today clock"));
  assert.equal(renamed.length, 1);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /HTTP 404/);
  const done = renamed[0].id;
  assert.equal(jarvis.store.getJob(done)?.title, "Fix the Today clock");
  const again = await jarvis.renameRoutineSessions();
  assert.equal(again.renamed.length + again.failed.length, 1, "the renamed one isn't tried again");
});

test("writeTitle runs in its own empty working folder under DATA_DIR", async () => {
  const dir = join(tmp(), "data");
  await writeTitle("/bin/false", undefined, "x", dir);
  assert.ok(existsSync(join(dir, "titles")));
});

// ── Other projects (JD-85): Drift ──

const DRIFT_ENV = "env_01Mr9vBBj7bB2BrjS1J1LNvB";
const DRIFT_RULES = "Run `npm run verify` before opening a PR. Node 24. E2E: never concurrently, use `E2E_PORT`. No deploys, purchases or production provider actions.";
/** The two-project PROJECTS line from the QA block, parsed as the server does. */
const TWO_PROJECTS = parseProjects(
  JSON.stringify([
    { slug: "jarvis", name: "JARVIS Desk", tickets: "collection://97df4bde-6ac0-42d6-a1cc-0b0838864dfb", repo: "MattSharp05/VirtualAssistant", prefix: "JD" },
    { slug: "drift", name: "Drift", repo: "MattSharp05/driftship", environment: DRIFT_ENV, aliases: ["drift", "driftship", "shelfzero"], baseBranch: "main", mergePolicy: "never", extraInstructions: DRIFT_RULES },
  ]),
);
const twoProjects = { projects: TWO_PROJECTS };

test("parseProjects: environment, aliases, base branch, merge policy and extra instructions", () => {
  const drift = TWO_PROJECTS[1];
  assert.deepEqual(drift, {
    slug: "drift",
    name: "Drift",
    repo: "MattSharp05/driftship",
    environment: DRIFT_ENV,
    aliases: ["drift", "driftship", "shelfzero"],
    baseBranch: "main",
    mergePolicy: "never",
    extraInstructions: DRIFT_RULES,
  });
  assert.equal("tickets" in drift, false, "tickets stays optional");
  assert.throws(() => parseProjects('[{"slug":"x","mergePolicy":"sometimes"}]'), /mergePolicy/);
  assert.equal(findProject("DriftShip", TWO_PROJECTS)?.slug, "drift");
  assert.equal(findProject("JARVIS Desk", TWO_PROJECTS)?.slug, "jarvis");
  assert.equal(findProject("nope", TWO_PROJECTS), undefined);
  assert.equal(describeProjects(TWO_PROJECTS), "jarvis (JARVIS Desk), drift (Drift; also driftship, shelfzero)");
});

test("planSession: Drift by name or alias gets its repo, environment, rules and no routine fallback", () => {
  for (const task of ["start a Drift session to run npm run verify", "Fix the checkout copy in driftship", "for ShelfZero: tidy the README", "drift: fix the checkout copy", "spin up a new driftship session to look at e2e"]) {
    const plan = planSession(task, config(tmp(), twoProjects));
    assert.equal(plan.repoUrl, "https://github.com/MattSharp05/driftship", task);
    assert.equal(plan.project, "drift", task);
    assert.equal(plan.projectName, "Drift", task);
    assert.equal(plan.environmentId, DRIFT_ENV, task);
    assert.equal(plan.routineFallback, false, task);
    assert.match(plan.rules ?? "", /Base branch: main/);
  }
  assert.equal(planSession("Fix the drift in the clock", config(tmp(), twoProjects)).project, "jarvis", "a bare word isn't a project mention");
});

test("start: a Drift session goes to driftship in Drift's environment, tagged project:drift, with its rules", async () => {
  const { fetchImpl, calls } = fakeFetch(created("session_01DRIFT"));
  const s = await starter(tmp(), { fetchImpl, configDir: loginDir() }, twoProjects).start("j9", "start a Drift session to fix the checkout copy", new Date("2026-10-21T10:00:00Z"));
  assert.equal(s.repoUrl, "https://github.com/MattSharp05/driftship");
  // The title keeps today's format; JD-82 owns the format and can use plan.projectName.
  assert.equal(s.title, "Fix the Today clock");
  assert.deepEqual(s.tags, ["project:drift", "role:task", "jarvis:j9"]);
  assert.equal(calls[0].body.environment_id, DRIFT_ENV);
  assert.deepEqual(calls[0].body.session_context, { sources: [{ git_repository: { url: "https://github.com/MattSharp05/driftship" } }] });
  const content = (calls[0].body.events as { data: { message: { content: string } } }[])[0].data.message.content;
  assert.match(content, /^WORKER RULES\n\n---\n\n\*\*Project rules\*\* \(Drift, MattSharp05\/driftship\):\n/);
  assert.match(content, /- Open a PR, never merge\./);
  assert.ok(content.includes(`- ${DRIFT_RULES}`), "the extra instructions");
  assert.match(content, /\n\nJARVIS job: j9\n[\s\S]*Task from Matthew:\nstart a Drift session to fix the checkout copy$/);
});

test("start: the default project still uses DEFAULT_REPO and SESSION_ENVIRONMENT_ID, with no project rules", async () => {
  const { fetchImpl, calls } = fakeFetch(created());
  const s = await starter(tmp(), { fetchImpl, configDir: loginDir() }, twoProjects).start("j10", "fix the clock", new Date());
  assert.equal(s.repoUrl, "https://github.com/MattSharp05/VirtualAssistant");
  assert.equal(calls[0].body.environment_id, "env_01TEST");
  const content = (calls[0].body.events as { data: { message: { content: string } } }[])[0].data.message.content;
  assert.doesNotMatch(content, /Project rules/);
});

test("startJob: project \"driftship\" wins over the task text", async () => {
  const { fetchImpl, calls } = fakeFetch(created("session_01D2"));
  const jarvis = jarvisWith(fetchImpl, loginDir(), twoProjects);
  const { job } = await jarvis.startJob("fix the checkout copy in trip", { project: "driftship" });
  assert.deepEqual(job.tags, ["project:drift", "role:task", "jarvis:j1"]);
  assert.equal(calls[0].body.environment_id, DRIFT_ENV);
  assert.deepEqual(calls[0].body.session_context, { sources: [{ git_repository: { url: "https://github.com/MattSharp05/driftship" } }] });
});

test("startJob: an unknown project errors and lists the known ones, without calling the API", async () => {
  const { fetchImpl, calls } = fakeFetch();
  const jarvis = jarvisWith(fetchImpl, loginDir(), twoProjects);
  await assert.rejects(jarvis.startJob("x", { project: "mars" }), /Unknown project "mars"\. Known projects: jarvis \(JARVIS Desk\), drift \(Drift; also driftship, shelfzero\)\./);
  assert.equal(calls.length, 0);
});

test("startJob: a Drift API failure is a clear error and never fires the routine", async () => {
  const { fetchImpl, calls } = fakeFetch(new Response("{}", { status: 503 }), new Response("{}", { status: 200 }));
  const jarvis = jarvisWith(fetchImpl, loginDir(), { ...twoProjects, routineId: "trig_1", routineToken: "t" });
  await assert.rejects(jarvis.startJob("start a Drift session to fix the checkout copy"), /^Error: Couldn't start a Drift session: session create answered HTTP 503/);
  assert.equal(calls.length, 1, "no routine fire");
  assert.equal(jarvis.store.firesInLastHour().length, 0);
  assert.equal(jarvis.store.recentJobs(10).length, 0);
});

test("start_session: the description lists the configured projects; the project argument reaches startJob", async () => {
  const tool = sessionsGroup.tools.find((t) => t.name === "start_session")!;
  const ctx = { config: config(tmp(), twoProjects) } as unknown as ToolContext;
  const description = typeof tool.description === "function" ? tool.description(ctx) : tool.description;
  assert.match(description, /Projects: jarvis \(JARVIS Desk\), drift \(Drift; also driftship, shelfzero\)\./);
  assert.ok("project" in (tool.inputSchema.properties as Record<string, unknown>));
  const seen: unknown[] = [];
  const jarvis = { startJob: async (task: string, opts: unknown) => (seen.push(task, opts), { job: { id: "j1", url: "u", title: "T" }, ms: 5 }) };
  await tool.handler({ task: "fix it", project: "drift" }, { ...ctx, jarvis } as unknown as ToolContext);
  assert.deepEqual(seen, ["fix it", { project: "drift" }]);
});

test("the report instructions work in any repo: the curl form, and scripts/report.sh only where it exists", () => {
  const instructions = loadWorkerInstructions();
  assert.match(instructions, /curl [^\n]*-X POST "\$\{JARVIS_REPORT_URL%\/\}\/api\/reports"/);
  assert.match(instructions, /Authorization: Bearer \$\{JARVIS_REPORT_SECRET\}/);
  assert.match(instructions, /~\/jarvis-report\.sh <job id> <sent-at time> "<message>"/);
  // The only mention of the repo's script is the guarded "use it where it exists".
  const mentions = instructions.split("\n").filter((l) => l.includes("scripts/report.sh"));
  assert.ok(mentions.length > 0 && mentions.every((l) => /-x scripts\/report\.sh|exec scripts\/report\.sh/.test(l) || l.startsWith("#")), mentions.join("\n"));
  assert.match(loadWorkerInstructions(join(tmp(), "nope.md")), /\$JARVIS_REPORT_URL\/api\/reports with curl/, "the built-in copy too");
});
