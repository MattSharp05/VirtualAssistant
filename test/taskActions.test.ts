import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent, TaskActionResponse, TaskItem, TaskQaResponse } from "@jarvis/shared";
import type { Brain } from "../src/brain/index.js";
import type { Config } from "../src/config.js";
import taskRoutes from "../src/desk/routes/tasks.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { NotionDesk, useNotionDesk } from "../src/desk/routes/notion.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { acceptanceChecklist } from "../src/notion.js";
import { NotionApi, notionIdsFile } from "../src/notionWrite.js";
import { setupNotion } from "../src/setupNotion.js";
import { Store } from "../src/store.js";
import { taskChatText, taskSessionText, TasksService, useTasksService } from "../src/tasks.js";
import { fakeNotion } from "./helpers/fakeNotion.js";

type Json = Record<string, unknown>;
const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-task-actions-"));
const text = (content: string) => [{ plain_text: content }];

test("acceptanceChecklist: the to_do items under an Acceptance criteria heading (nested ones too), nothing without that heading", () => {
  const blocks = [
    { id: "a", type: "heading_2" as const, text: "Context" },
    { id: "b", type: "paragraph" as const, text: "blah" },
    { id: "c", type: "heading_2" as const, text: "Acceptance criteria" },
    { id: "d", type: "todo" as const, text: "Does X", checked: true },
    {
      id: "e",
      type: "todo" as const,
      text: "Does Y",
      checked: false,
      children: [{ id: "f", type: "todo" as const, text: "Nested Z", checked: true }],
    },
    { id: "g", type: "heading_2" as const, text: "Technical notes" },
    { id: "h", type: "todo" as const, text: "Not counted", checked: false },
  ];
  assert.deepEqual(acceptanceChecklist(blocks), [
    { text: "Does X", checked: true },
    { text: "Does Y", checked: false },
    { text: "Nested Z", checked: true },
  ]);
  assert.deepEqual(acceptanceChecklist([{ id: "x", type: "paragraph", text: "no heading" }]), []);
});

test("taskChatText / taskSessionText: the to-do plus context; the project prefix routes a session to its repo", () => {
  const task: TaskItem = { id: "t1", name: "Confirm hotel cancellation policy", status: "Open", project: "Trip", source: "Notion QA", createdAt: "" };
  assert.equal(taskChatText(task, "Is this still accurate?"), "A to-do of mine (Trip): Confirm hotel cancellation policy\n\nIs this still accurate?");
  assert.equal(taskChatText({ ...task, project: undefined }, undefined), "A to-do of mine: Confirm hotel cancellation policy");
  assert.equal(taskSessionText(task, "spike it"), "Trip: Confirm hotel cancellation policy\n\nspike it");
  assert.equal(taskSessionText({ ...task, project: undefined }, ""), "Confirm hotel cancellation policy");
});

/** JARVIS Tasks + a ticket page with an Acceptance Criteria checklist, in a fake Notion. */
async function setup() {
  const dir = tmp();
  const notion = fakeNotion();
  await setupNotion(new NotionApi("secret", notion.fetchImpl), notion.PARENT, notionIdsFile(dir));
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const jarvis = new Jarvis({ dataDir: dir, notionToken: "secret", projects: [] } as unknown as Config, new Store(dir));
  const svc = new TasksService(dir, "secret", bus, notion.fetchImpl, () => new Date(2026, 9, 21, 9, 0));
  useTasksService(jarvis, svc);
  useNotionDesk(jarvis, new NotionDesk(dir, "secret", notion.fetchImpl));

  const api = new NotionApi("secret", notion.fetchImpl);
  const { id: ticketId } = await api.call("POST", "/pages", {
    parent: { page_id: notion.OTHER },
    properties: { title: { title: [{ text: { content: "TR-91" } }] } },
  });
  await api.call("PATCH", `/blocks/${String(ticketId)}/children`, {
    children: [
      { object: "block", type: "heading_2", heading_2: { rich_text: text("Acceptance criteria") } },
      { object: "block", type: "to_do", to_do: { rich_text: text("Cancelling inside 24h shows the correct refund"), checked: true } },
      { object: "block", type: "to_do", to_do: { rich_text: text("A second cancellation attempt is blocked"), checked: false } },
    ],
  });
  const ticketUrl = `https://www.notion.so/${String(ticketId)}`;
  const task = await svc.suggest({ name: "QA TR-91: Confirm hotel cancellation policy", source: "Notion QA", link: ticketUrl, dedupeKey: "notionqa:Trip:TR-91", why: "TR-91 is waiting for your QA in Trip.", project: "Trip" });
  await svc.accept(task.id);

  const started: string[] = [];
  jarvis.startJob = async (job: string) => {
    started.push(job);
    const result = { id: "j20", sessionId: "session_01TASK", url: "https://claude.ai/code/session_01TASK", task: job, createdAt: "", kind: "started" as const };
    return { job: result, ms: 1, via: "api" as const };
  };
  const chats: { text: string; channel: string }[] = [];
  const brain = {
    start: (chatText: string, channel: string) => {
      chats.push({ text: chatText, channel });
      return { messageId: "m1", done: Promise.resolve() };
    },
  } as unknown as Brain;
  const ctx = { jarvis, bus, brain } as unknown as DeskContext;
  const route = (path: string) => taskRoutes.find((r) => r.path === path)!;
  const call = (path: string, extra: Json = {}) => Promise.resolve().then(() => route(path).handler({ ctx, params: {}, body: {}, ...extra } as never));
  return { dir, notion, svc, jarvis, ctx, bus, events, call, started, chats, taskId: task.id, ticketUrl };
}

test("task actions: Chat with JARVIS and Start a session mirror Ideas; history records both", async () => {
  const s = await setup();

  const chat = (await s.call("/tasks/:id/chat", { params: { id: s.taskId }, body: { context: "Still accurate?" } })) as TaskActionResponse;
  assert.equal(chat.messageId, "m1");
  assert.deepEqual(s.chats, [{ text: "A to-do of mine (Trip): QA TR-91: Confirm hotel cancellation policy\n\nStill accurate?", channel: "desk-typed" }]);
  assert.deepEqual(chat.task.history?.map((h) => h.kind), ["chat"]);

  await assert.rejects(
    Promise.resolve().then(() => taskRoutes.find((r) => r.path === "/tasks/:id/chat")!.handler({ ctx: { ...s.ctx, brain: undefined }, params: { id: s.taskId }, body: {} } as never)),
    (e: Error & { status?: number }) => e.status === 503,
  );

  const session = (await s.call("/tasks/:id/session", { params: { id: s.taskId }, body: { context: "spike it" } })) as TaskActionResponse;
  assert.deepEqual(s.started, ["Trip: QA TR-91: Confirm hotel cancellation policy\n\nspike it"]);
  assert.deepEqual(session.session, { name: "j20", url: "https://claude.ai/code/session_01TASK" });
  assert.deepEqual(session.task.history?.map((h) => [h.kind, h.link, h.label]), [
    ["chat", undefined, undefined],
    ["session", "https://claude.ai/code/session_01TASK", "j20"],
  ]);
  assert.ok(s.events.some((e) => e.type === "sessions.changed"));
  assert.ok(s.events.filter((e) => e.type === "tasks.changed").length >= 2, "each action publishes tasks.changed");
});

test("task QA panel: the ticket's Acceptance Criteria checklist, read live from Notion; refused for a non-QA task", async () => {
  const s = await setup();
  const qa = (await s.call("/tasks/:id/qa", { params: { id: s.taskId } })) as TaskQaResponse;
  assert.deepEqual(qa.checklist, [
    { text: "Cancelling inside 24h shows the correct refund", checked: true },
    { text: "A second cancellation attempt is blocked", checked: false },
  ]);

  const plain = await s.svc.add({ name: "Buy milk" });
  await assert.rejects(
    Promise.resolve().then(() => s.call("/tasks/:id/qa", { params: { id: plain.id } })),
    (e: Error & { status?: number }) => e.status === 400,
  );

  await assert.rejects(
    Promise.resolve().then(() => s.call("/tasks/:id/qa", { params: { id: "nope" } })),
    (e: Error & { status?: number }) => e.status === 400,
  );
});
