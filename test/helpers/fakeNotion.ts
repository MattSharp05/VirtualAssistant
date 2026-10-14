// An in-memory Notion API for tests: pages, databases, blocks (with `after` inserts and deletes),
// database rows and queries; enough for setup, tasks and memory.
import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;
const hex = () => randomUUID().replace(/-/g, "");

/** An in-memory Notion: pages, databases, blocks and database rows, enough for setup + tasks + memory. */
export function fakeNotion() {
  const objects = new Map<string, Json>(); // id → page / database / block
  const children = new Map<string, string[]>(); // parent id → child block ids
  const calls: string[] = [];
  let seq = 0;
  /** Pages carry last_edited_time like Notion's, bumped on every change below them. */
  const touch = (pageId: string) => {
    const page = objects.get(pageId);
    if (page) page.last_edited_time = new Date(Date.now() + seq++).toISOString();
  };
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
      const made = (body.children as Json[]).map((c) => ({ ...c, object: "block", id: hex(), created_time: new Date(Date.now() + seq++).toISOString(), parent: { type: "page_id", page_id: m![1] } }));
      made.forEach((b) => objects.set(String(b.id), b));
      const list = children.get(m[1]) ?? [];
      const at = body.after ? list.indexOf(String(body.after)) + 1 : list.length;
      list.splice(at, 0, ...made.map((b) => String(b.id)));
      children.set(m[1], list);
      touch(m[1]);
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
      if (method === "DELETE") {
        const parent = String(((objects.get(m[1])!.parent ?? {}) as Json).page_id ?? "");
        objects.delete(m[1]);
        children.set(parent, (children.get(parent) ?? []).filter((id) => id !== m![1]));
        touch(parent);
      }
      return ok({ id: m[1] });
    }
    return new Response(JSON.stringify({ message: `fake: no route ${method} ${path}` }), { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, PARENT, OTHER, calls, children, objects, touch };
}
