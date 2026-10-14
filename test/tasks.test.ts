import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeskEvent, TasksResponse } from "@jarvis/shared";
import type { Config } from "../src/config.js";
import taskRoutes from "../src/desk/routes/tasks.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import { EventBus } from "../src/events.js";
import { Jarvis } from "../src/jarvis.js";
import { NotionApi, NotionWriteRefused, NotionWriter, normalizeId, notionIdsFile } from "../src/notionWrite.js";
import { MEMORY_TITLE, setupNotion, TASKS_TITLE } from "../src/setupNotion.js";
import { Store } from "../src/store.js";
import { TasksService, useTasksService } from "../src/tasks.js";
import tasksGroup from "../src/tools/tasks.js";
import { fakeNotion } from "./helpers/fakeNotion.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-tasks-"));
type Json = Record<string, unknown>;

test("setup:notion creates JARVIS Memory + JARVIS Tasks once and saves their ids", async () => {
  const dir = tmp();
  const notion = fakeNotion();
  const api = new NotionApi("secret", notion.fetchImpl);
  const first = await setupNotion(api, `https://www.notion.so/JARVIS-${notion.PARENT}`, notionIdsFile(dir));
  assert.deepEqual(first.created, [MEMORY_TITLE, TASKS_TITLE]);
  const saved = notionIdsFile(dir).get();
  assert.equal(saved.memoryPageId, first.memoryPageId);
  assert.equal(saved.tasksDatabaseId, first.tasksDatabaseId);
  const db = notion.objects.get(saved.tasksDatabaseId!)!;
  assert.deepEqual(Object.keys(db.properties as Json), ["Name", "Status", "Due", "Project", "Priority", "Source", "Source link", "Dedupe key", "Created"]);

  const again = await setupNotion(api, notion.PARENT, notionIdsFile(dir));
  assert.deepEqual(again.created, [], "a re-run creates nothing");
  assert.equal(notion.children.get(notion.PARENT)!.length, 2);

  // Lost notion.json (new volume): found again under the parent instead of duplicated.
  const fresh = await setupNotion(api, notion.PARENT, notionIdsFile(tmp()));
  assert.deepEqual(fresh.created, []);
  assert.equal(fresh.tasksDatabaseId, first.tasksDatabaseId);
});

test("notionWrite refuses every page, database and block that isn't JARVIS Memory / JARVIS Tasks", async () => {
  const dir = tmp();
  const notion = fakeNotion();
  const api = new NotionApi("secret", notion.fetchImpl);
  const ids = await setupNotion(api, notion.PARENT, notionIdsFile(dir));
  const writer = new NotionWriter(api, () => ids);

  await assert.rejects(writer.appendBlocks(notion.OTHER, []), (err: Error) => err instanceof NotionWriteRefused && /only writes to the JARVIS Memory page and the JARVIS Tasks database; page \w+ is neither/.test(err.message));
  await assert.rejects(writer.createRow(notion.PARENT, {}), NotionWriteRefused);
  await assert.rejects(writer.queryRows(ids.memoryPageId!), NotionWriteRefused, "the memory page isn't a database");
  // A block on another page and a row outside the Tasks database are refused after checking their parent.
  const [foreign] = (await new NotionApi("secret", notion.fetchImpl).call("PATCH", `/blocks/${notion.OTHER}/children`, { children: [{ type: "paragraph" }] })).results as Json[];
  await assert.rejects(writer.deleteBlock(String(foreign.id)), NotionWriteRefused);
  await assert.rejects(writer.updateRow(ids.memoryPageId!, {}), NotionWriteRefused);
  const before = notion.calls.filter((c) => !c.startsWith("GET")).length;
  await assert.rejects(new NotionWriter(api, () => ({})).appendBlocks(notion.OTHER, []), /run `npm run setup:notion` first/);
  assert.equal(notion.calls.filter((c) => !c.startsWith("GET")).length, before, "refused writes never reach Notion");

  // The allowed ones work.
  const [mine] = await writer.appendBlocks(ids.memoryPageId!, [{ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [] } }]);
  await writer.deleteBlock(String(mine.id));
  assert.equal(normalizeId(`https://www.notion.so/My-Page-${ids.memoryPageId}`), ids.memoryPageId);
});

test("tasks: add → today; complete → Done; changes publish tasks.changed; tools and Desk routes", async () => {
  const dir = tmp();
  const notion = fakeNotion();
  await setupNotion(new NotionApi("secret", notion.fetchImpl), notion.PARENT, notionIdsFile(dir));
  const bus = new EventBus();
  const events: DeskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const svc = new TasksService(dir, "secret", bus, notion.fetchImpl, () => new Date(2026, 9, 14, 9, 0));

  const passport = await svc.add({ name: "Renew passport", due: "2026-10-14", priority: "P1" });
  await svc.add({ name: "Book dentist", due: "2026-10-20", project: "Health" });
  await svc.add({ name: "Read Trip PRD" });
  assert.equal(events.filter((e) => e.type === "tasks.changed").length, 3);
  assert.deepEqual((await svc.list("today")).map((t) => t.name), ["Renew passport"]);
  assert.deepEqual((await svc.list("upcoming")).map((t) => t.name), ["Book dentist", "Read Trip PRD"]);
  assert.equal(passport.source, "You");
  assert.equal(passport.status, "Open");

  const done = await svc.complete("passport");
  assert.equal(done.status, "Done");
  assert.equal(((notion.objects.get(passport.id)!.properties as Json).Status as { select: { name: string } }).select.name, "Done", "written to Notion");
  assert.deepEqual((await svc.list("today")).map((t) => t.name), [], "the cache reflects JARVIS's own write at once");
  assert.deepEqual((await svc.list("done")).map((t) => t.name), ["Renew passport"]);
  await assert.rejects(svc.add({ name: "x", due: "Friday" }), /Due must be a date/);
  await assert.rejects(svc.complete("nothing like it"), /No open task matches/);

  // The tools the brain calls.
  const jarvis = new Jarvis({ dataDir: dir, notionToken: "secret" } as Config, new Store(dir));
  useTasksService(jarvis, svc);
  const ctx = { jarvis, config: jarvis.config };
  const tool = (name: string) => tasksGroup.tools.find((t) => t.name === name)!;
  assert.match(await tool("add_task").handler({ name: "Call mum", due: "2026-10-17" }, ctx), /Added: Call mum \(due 2026-10-17\)/);
  assert.match(await tool("list_tasks").handler({ when: "upcoming" }, ctx), /Call mum \(due 2026-10-17\)[\s\S]*Book dentist/);
  assert.match(await tool("complete_task").handler({ task: "call mum" }, ctx), /Done: Call mum/);
  assert.match(await tool("update_task").handler({ task: "dentist", due: "2026-10-21" }, ctx), /Book dentist \(due 2026-10-21, Health\)/);

  // The Desk routes.
  const deskCtx = { jarvis, bus } as unknown as DeskContext;
  const route = (method: string, path: string) => taskRoutes.find((r) => r.method === method && r.path === path)!;
  const call = (method: string, path: string, extra: Json) => route(method, path).handler({ ctx: deskCtx, params: {}, body: {}, ...extra } as never);
  const upcoming = (await call("GET", "/tasks", { url: new URL("http://x/api/desk/tasks?view=upcoming") })) as TasksResponse;
  assert.deepEqual(upcoming.tasks.map((t) => t.name), ["Book dentist", "Read Trip PRD"]);
  const added = (await call("POST", "/tasks", { body: { name: "Water plants", due: "2026-10-14" } })) as { id: string };
  await call("POST", "/tasks/:id/done", { params: { id: added.id } });
  await call("POST", "/tasks/:id/reopen", { params: { id: added.id } });
  assert.deepEqual(((await call("GET", "/tasks", { url: new URL("http://x/?view=today") })) as TasksResponse).tasks.map((t) => t.name), ["Water plants"]);
  await assert.rejects(Promise.resolve().then(() => call("GET", "/tasks", { url: new URL("http://x/?view=nope") })), /view must be one of/);
  await assert.rejects(Promise.resolve().then(() => call("POST", "/tasks", { body: { name: "" } })), (e: Error & { status?: number }) => e.status === 400);
});

test("tasks without setup or a token explain what to do", async () => {
  await assert.rejects(new TasksService(tmp(), undefined).list("today"), /NOTION_TOKEN is not set/);
  await assert.rejects(new TasksService(tmp(), "secret", undefined, fakeNotion().fetchImpl).list("today"), /run `npm run setup:notion/);
});
