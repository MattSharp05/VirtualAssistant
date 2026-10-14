import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-tasks-"));
type Json = Record<string, unknown>;
const hex = () => randomUUID().replace(/-/g, "");

/** An in-memory Notion: pages, databases, blocks and database rows, enough for setup + tasks + memory. */
function fakeNotion() {
  const objects = new Map<string, Json>(); // id → page / database / block
  const children = new Map<string, string[]>(); // parent id → child block ids
  const calls: string[] = [];
  const add = (parent: string, obj: Json) => {
    objects.set(String(obj.id), obj);
    children.set(parent, [...(children.get(parent) ?? []), String(obj.id)]);
  };
  const PARENT = hex();
  objects.set(PARENT, { object: "page", id: PARENT, parent: { type: "workspace" } });
  const OTHER = hex();
  objects.set(OTHER, { object: "page", id: OTHER, parent: { type: "workspace" } });

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.notion.com/v1", "");
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : {};
    calls.push(`${method} ${path.split("?")[0]}`);
    const ok = (json: Json) => new Response(JSON.stringify(json), { status: 200 });
    const notFound = () => new Response(JSON.stringify({ message: "Could not find object" }), { status: 404 });
    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = path.match(/^\/(pages|databases|blocks)\/([0-9a-f]+)$/))) return objects.has(m[2]) ? ok(objects.get(m[2])!) : notFound();
    if (method === "GET" && (m = path.match(/^\/blocks\/([0-9a-f]+)\/children/))) return ok({ results: (children.get(m[1]) ?? []).map((id) => objects.get(id)), has_more: false });
    if (method === "PATCH" && (m = path.match(/^\/blocks\/([0-9a-f]+)\/children$/))) {
      const made = (body.children as Json[]).map((c) => ({ ...c, id: hex(), parent: { type: "page_id", page_id: m![1] } }));
      made.forEach((b) => add(m![1], b));
      return ok({ results: made });
    }
    if (method === "POST" && path === "/pages") {
      const parent = body.parent as Json;
      const id = hex();
      if (parent.database_id) {
        const row = { object: "page", id, url: `https://www.notion.so/${id}`, created_time: "2026-10-14T10:00:00.000Z", parent: { type: "database_id", database_id: parent.database_id }, properties: { ...(body.properties as Json), Created: { created_time: "2026-10-14T10:00:00.000Z" } } };
        add(String(parent.database_id), row);
        return ok(row);
      }
      const title = (((body.properties as Json).title as Json).title as Json[])[0] as Json;
      add(String(parent.page_id), { object: "block", type: "child_page", id, child_page: { title: (title.text as Json).content }, parent: { type: "page_id", page_id: parent.page_id } });
      objects.set(id, { ...objects.get(id), object: "page" }); // the page and its child_page block share an id
      return ok({ id });
    }
    if (method === "POST" && path === "/databases") {
      const id = hex();
      const parent = body.parent as Json;
      const title = ((body.title as Json[])[0].text as Json).content;
      add(String(parent.page_id), { object: "block", type: "child_database", id, child_database: { title }, parent: { type: "page_id", page_id: parent.page_id } });
      objects.set(id, { ...objects.get(id), object: "database", properties: body.properties });
      return ok({ id });
    }
    if (method === "POST" && (m = path.match(/^\/databases\/([0-9a-f]+)\/query$/))) {
      const not = (((body.filter as Json)?.select as Json)?.does_not_equal as string) ?? "";
      const rows = (children.get(m[1]) ?? []).map((id) => objects.get(id)!).filter((r) => ((r.properties as Json).Status as Json)?.select && (((r.properties as Json).Status as Json).select as Json).name !== not);
      return ok({ results: rows, has_more: false });
    }
    if (method === "PATCH" && (m = path.match(/^\/pages\/([0-9a-f]+)$/))) {
      const row = objects.get(m[1]);
      if (!row) return notFound();
      row.properties = { ...(row.properties as Json), ...(body.properties as Json) };
      return ok(row);
    }
    if ((method === "PATCH" || method === "DELETE") && (m = path.match(/^\/blocks\/([0-9a-f]+)$/))) {
      if (!objects.has(m[1])) return notFound();
      if (method === "DELETE") objects.delete(m[1]);
      return ok({ id: m[1] });
    }
    return new Response(JSON.stringify({ message: `fake: no route ${method} ${path}` }), { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, PARENT, OTHER, calls, children, objects };
}

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
