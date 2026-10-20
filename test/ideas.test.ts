import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent, DeskIdea, IdeaActionResponse, IdeasResponse } from "@jarvis/shared";
import type { Brain } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import ideaRoutes from "../src/desk/routes/ideas.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { ideaChatText, ideaProjects, ideaSessionTask, IdeasStore, ideaSuggestion, ideaTitle } from "../src/ideas.js";
import { Jarvis } from "../src/jarvis.js";
import { NotionApi, notionIdsFile } from "../src/notionWrite.js";
import { planSession } from "../src/sessionStart.js";
import { setupNotion } from "../src/setupNotion.js";
import { Store, type Job } from "../src/store.js";
import { TasksService, useTasksService } from "../src/tasks.js";
import { fakeNotion } from "./helpers/fakeNotion.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-ideas-"));
type Json = Record<string, unknown>;

const PROJECTS = [
  { slug: "jarvis", name: "JARVIS Desk", repo: "MattSharp05/VirtualAssistant", prefix: "JD" },
  { slug: "trip", name: "Trip planner", repo: "MattSharp05/trip" },
];

test("ideas store: add, edit, retag, history and delete; persists across a restart; publishes ideas.changed", async () => {
  const dir = tmp();
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  let clock = Date.parse("2026-10-20T08:00:00Z");
  let n = 0;
  const store = new IdeasStore(dir, bus, () => new Date((clock += 60_000)), () => `i${++n}`);

  const a = await store.add({ text: "Voice notes straight into Ideas\n\nAfter the wake word.", project: "jarvis" });
  const b = await store.add({ text: "Read-later queue from Slack saves" });
  assert.equal(a.project, "jarvis");
  assert.equal(b.project, undefined, "no project = Unsorted");
  assert.deepEqual(store.list().map((i) => i.id), ["i2", "i1"], "newest first");
  await assert.rejects(store.add({ text: "   \n " }), /needs some text/);

  const edited = await store.update("i1", { text: "Voice notes into Ideas" });
  assert.equal(edited.text, "Voice notes into Ideas");
  assert.equal(edited.project, "jarvis", "a text edit keeps the project");
  assert.ok(edited.updatedAt > a.updatedAt);
  assert.equal((await store.update("i1", { project: "" })).project, undefined, "\"\" moves it to Unsorted");
  assert.equal((await store.update("i2", { project: "trip" })).project, "trip");
  await assert.rejects(store.update("nope", { text: "x" }), /No idea nope/);

  const withHistory = await store.record("i2", { kind: "session", link: "https://claude.ai/code/session_01X", label: "j7" });
  assert.equal(withHistory.history.length, 1);
  assert.equal(withHistory.history[0].kind, "session");

  // A restart reads the same file.
  const again = new IdeasStore(dir);
  assert.deepEqual(again.list().map((i) => [i.id, i.project, i.history.length]), [["i2", "trip", 1], ["i1", undefined, 0]]);
  assert.match(readFileSync(join(dir, "ideas.json"), "utf8"), /Voice notes into Ideas/);

  await store.remove("i1");
  assert.deepEqual(store.list().map((i) => i.id), ["i2"]);
  assert.equal(events.filter((e) => e.type === "ideas.changed").length, 7);
});

test("ideas: projects from PROJECTS + session tags; the to-do, chat and session mappings", () => {
  const jobs = [
    { id: "j1", tags: ["project:mk", "role:task"] },
    { id: "j2", tags: ["project:jarvis"] },
    { id: "j3" },
  ] as Job[];
  const projects = ideaProjects(PROJECTS, jobs);
  assert.deepEqual(projects, [
    { slug: "jarvis", name: "JARVIS Desk" },
    { slug: "trip", name: "Trip planner" },
    { slug: "mk", name: "mk" },
  ]);

  const idea: DeskIdea = { id: "abc", text: "\nWeekly cost digest in Today\nspend per project", project: "jarvis", createdAt: "", updatedAt: "", history: [] };
  assert.equal(ideaTitle(idea.text), "Weekly cost digest in Today");
  assert.deepEqual(ideaSuggestion(idea, "  this week  ", projects), {
    name: "Weekly cost digest in Today",
    source: "Idea",
    dedupeKey: "idea:abc",
    why: "this week",
    project: "JARVIS Desk",
  });
  assert.equal(ideaSuggestion({ ...idea, project: undefined }, undefined, projects).why, "");
  assert.equal(ideaSuggestion({ ...idea, project: undefined }, undefined, projects).project, undefined);

  assert.equal(ideaChatText(idea, "Is it worth it?", projects), "An idea of mine for JARVIS Desk:\n\nWeekly cost digest in Today\nspend per project\n\nIs it worth it?");

  // The session task puts the session on the project's repo, tagged with its slug.
  const task = ideaSessionTask(idea, "spike it", projects);
  assert.equal(task, "jarvis: Weekly cost digest in Today\nspend per project\n\nspike it");
  const config = { projects: PROJECTS, defaultRepo: "MattSharp05/other" };
  assert.deepEqual(planSession(task, config), { repoUrl: "https://github.com/MattSharp05/VirtualAssistant", project: "jarvis", role: "task" });
  assert.equal(planSession(ideaSessionTask({ ...idea, project: "trip" }, "", projects), config).repoUrl, "https://github.com/MattSharp05/trip");
  assert.equal(planSession(ideaSessionTask({ ...idea, project: undefined }, "", projects), config).repoUrl, "https://github.com/MattSharp05/other");
});

test("ideas Desk routes: CRUD, Add to to-dos (once), Chat with JARVIS, Start a session", async () => {
  const dir = tmp();
  const notion = fakeNotion();
  await setupNotion(new NotionApi("secret", notion.fetchImpl), notion.PARENT, notionIdsFile(dir));
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const jarvis = new Jarvis({ dataDir: dir, notionToken: "secret", projects: PROJECTS } as unknown as Config, new Store(dir));
  const svc = new TasksService(dir, "secret", bus, notion.fetchImpl, () => new Date(2026, 9, 20, 9, 0));
  useTasksService(jarvis, svc);
  const started: string[] = [];
  jarvis.startJob = async (task: string) => {
    started.push(task);
    const job = { id: "j9", sessionId: "session_01IDEA", url: "https://claude.ai/code/session_01IDEA", task, createdAt: "", kind: "started" as const };
    return { job, ms: 1, via: "api" as const };
  };
  const chats: { text: string; channel: string }[] = [];
  const brain = {
    start: (text: string, channel: string) => {
      chats.push({ text, channel });
      return { messageId: "m1", done: Promise.resolve() };
    },
  } as unknown as Brain;
  const ctx = { jarvis, bus, brain } as unknown as DeskContext;
  const route = (method: string, path: string) => ideaRoutes.find((r) => r.method === method && r.path === path)!;
  const call = (method: string, path: string, extra: Json = {}) => Promise.resolve().then(() => route(method, path).handler({ ctx, params: {}, body: {}, ...extra } as never));

  const created = (await call("POST", "/ideas", { body: { text: "Weekly cost digest in Today", project: "jarvis" } })) as DeskIdea;
  const list = (await call("GET", "/ideas")) as IdeasResponse;
  assert.deepEqual(list.ideas.map((i) => i.id), [created.id]);
  assert.deepEqual(list.projects.map((p) => p.slug), ["jarvis", "trip"]);
  await assert.rejects(call("POST", "/ideas", { body: { text: "" } }), (e: Error & { status?: number }) => e.status === 400);

  const retagged = (await call("POST", "/ideas/:id", { params: { id: created.id }, body: { project: null } })) as DeskIdea;
  assert.equal(retagged.project, undefined);
  await call("PUT", "/ideas/:id", { params: { id: created.id }, body: { project: "jarvis", text: "Weekly cost digest in Today\nper project" } });
  await assert.rejects(call("POST", "/ideas/:id", { params: { id: "nope" }, body: { text: "x" } }), (e: Error & { status?: number }) => e.status === 404);

  // Add to to-dos: a Suggested row with source Idea, the context as why; only once.
  const todo = (await call("POST", "/ideas/:id/todo", { params: { id: created.id }, body: { context: "before Friday" } })) as IdeaActionResponse;
  assert.equal(todo.task?.status, "Suggested");
  assert.equal(todo.task?.source, "Idea");
  assert.equal(todo.task?.name, "Weekly cost digest in Today");
  assert.equal(todo.task?.project, "JARVIS Desk");
  assert.equal(todo.task?.why, "before Friday");
  assert.deepEqual(todo.idea.history.map((h) => h.kind), ["todo"]);
  assert.deepEqual((await svc.list("suggested")).map((t) => t.name), ["Weekly cost digest in Today"]);
  const again = (await call("POST", "/ideas/:id/todo", { params: { id: created.id }, body: {} })) as IdeaActionResponse;
  assert.equal(again.task?.id, todo.task?.id, "the same suggestion, not a second one");
  assert.equal(again.idea.history.length, 1);
  assert.equal((await svc.list("suggested")).length, 1);
  const row = [...notion.objects.values()].find((o) => o.id === todo.task!.id)!;
  assert.equal(((row.properties as Json)["Dedupe key"] as { rich_text: { text: { content: string } }[] }).rich_text[0].text.content, `idea:${created.id}`);

  // Chat with JARVIS: through the brain's normal path.
  const chat = (await call("POST", "/ideas/:id/chat", { params: { id: created.id }, body: { context: "What would it cost?" } })) as IdeaActionResponse;
  assert.equal(chat.messageId, "m1");
  assert.deepEqual(chats, [{ text: "An idea of mine for JARVIS Desk:\n\nWeekly cost digest in Today\nper project\n\nWhat would it cost?", channel: "desk-typed" }]);
  await assert.rejects(
    Promise.resolve().then(() => route("POST", "/ideas/:id/chat").handler({ ctx: { ...ctx, brain: undefined }, params: { id: created.id }, body: {} } as never)),
    (e: Error & { status?: number }) => e.status === 503,
  );

  // Start a session: on the project's repo, the history links to it.
  const session = (await call("POST", "/ideas/:id/session", { params: { id: created.id }, body: { context: "spike it" } })) as IdeaActionResponse;
  assert.deepEqual(started, ["jarvis: Weekly cost digest in Today\nper project\n\nspike it"]);
  assert.deepEqual(session.session, { name: "j9", url: "https://claude.ai/code/session_01IDEA" });
  assert.deepEqual(session.idea.history.map((h) => [h.kind, h.link, h.label]), [
    ["todo", todo.task?.url, undefined],
    ["chat", undefined, undefined],
    ["session", "https://claude.ai/code/session_01IDEA", "j9"],
  ]);
  assert.ok(events.some((e) => e.type === "sessions.changed"));

  // Ideas stay in the list after actions; delete removes them.
  assert.equal(((await call("GET", "/ideas")) as IdeasResponse).ideas.length, 1);
  assert.deepEqual(await call("POST", "/ideas/:id/delete", { params: { id: created.id } }), { ok: true });
  assert.equal(((await call("GET", "/ideas")) as IdeasResponse).ideas.length, 0);
  await assert.rejects(call("DELETE", "/ideas/:id", { params: { id: created.id } }), (e: Error & { status?: number }) => e.status === 404);
  assert.ok(events.filter((e) => e.type === "ideas.changed").length >= 6);
});
