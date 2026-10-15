import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NotionPage, NotionPinnedResponse, NotionSearchResponse } from "@jarvis/shared";
import type { Config } from "../src/config.js";
import type { DeskContext } from "../src/desk/routes/index.js";
import notionRoutes, { NotionDesk, RECENT_MAX, useNotionDesk } from "../src/desk/routes/notion.js";
import { Jarvis } from "../src/jarvis.js";
import { Notion } from "../src/notion.js";
import { NotionApi, notionIdsFile } from "../src/notionWrite.js";
import { setupNotion } from "../src/setupNotion.js";
import { Store } from "../src/store.js";
import { fakeNotion } from "./helpers/fakeNotion.js";

const tmp = () => mkdtempSync(join(tmpdir(), "jarvis-desk-notion-"));
type Json = Record<string, unknown>;

const rich = (text: string) => [{ plain_text: text }];
const PRD = "a1".repeat(16);
const CHILD = "c2".repeat(16);

/** The Mario Kart PRD in the fake: properties, headings, lists (one nested), to-dos, code, a child page. */
function seedPrd(notion: ReturnType<typeof fakeNotion>): void {
  notion.objects.set(PRD, {
    object: "page",
    id: PRD,
    url: `https://www.notion.so/Mario-Kart-PRD-${PRD}`,
    last_edited_time: "2026-10-12T10:00:00.000Z",
    properties: {
      Name: { type: "title", title: rich("Mario Kart PRD") },
      Status: { type: "status", status: { name: "Approved" } },
      Owner: { type: "people", people: [{ name: "Matthew" }] },
      Notes: { type: "rich_text", rich_text: [] },
    },
  });
  notion.objects.set(CHILD, { object: "page", id: CHILD, properties: { title: { type: "title", title: rich("Track list") } } });
  const blocks: Json[] = [
    { type: "heading_1", heading_1: { rich_text: rich("Goals") } },
    { type: "paragraph", paragraph: { rich_text: rich("A browser kart racer with three tracks.") } },
    { type: "paragraph", paragraph: { rich_text: [] } },
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: rich("Time trials") }, has_children: true, nest: [{ type: "bulleted_list_item", bulleted_list_item: { rich_text: rich("Ghost of your best lap") } }] },
    { type: "to_do", to_do: { rich_text: rich("Lap counter and timer"), checked: true } },
    { type: "to_do", to_do: { rich_text: rich("Drift boost tuning (MK-81)"), checked: false } },
    { type: "code", code: { rich_text: rich("const CAP = 1.2;"), language: "typescript" } },
    { type: "callout", callout: { rich_text: rich("Speed is capped"), icon: { emoji: "⚠️" } } },
    { type: "image", image: {} },
    { type: "child_page", id: CHILD, child_page: { title: "Track list" } },
  ];
  const ids: string[] = [];
  blocks.forEach((b, i) => {
    const id = (b.id as string | undefined) ?? `b${i}`.padEnd(32, "0");
    const { nest, ...block } = b;
    // A child page and its block share an id (and, in the fake, one object).
    notion.objects.set(id, { object: "block", ...block, id, ...notion.objects.get(id) });
    ids.push(id);
    if (Array.isArray(nest)) {
      const kid = `n${i}`.padEnd(32, "0");
      notion.objects.set(kid, { object: "block", ...(nest[0] as Json), id: kid });
      notion.children.set(id, [kid]);
    }
  });
  notion.children.set(PRD, ids);
}

async function setup({ connected = true } = {}) {
  const token = connected ? "secret" : undefined;
  const dir = tmp();
  const notion = fakeNotion();
  await setupNotion(new NotionApi("secret", notion.fetchImpl), notion.PARENT, notionIdsFile(dir));
  seedPrd(notion);
  const jarvis = new Jarvis({ dataDir: dir, notionToken: token } as Config, new Store(dir));
  useNotionDesk(jarvis, new NotionDesk(dir, token, notion.fetchImpl));
  const ctx = { jarvis } as unknown as DeskContext;
  const call = (method: string, path: string, extra: Partial<{ url: URL; params: Json; body: Json }> = {}) =>
    Promise.resolve().then(() =>
      notionRoutes.find((r) => r.method === method && r.path === path)!.handler({ ctx, params: {}, body: {}, url: new URL("http://x/"), ...extra } as never),
    );
  return { dir, notion, call };
}

const status = (code: number) => (err: Error & { status?: number }) => err.status === code;

test("search finds pages by title; the page reads as structured blocks with its properties", async () => {
  const { call } = await setup();
  const found = (await call("GET", "/notion/search", { url: new URL("http://x/?q=PRD") })) as NotionSearchResponse;
  assert.equal(found.query, "PRD");
  assert.deepEqual(found.results.map((r) => [r.id, r.title, r.kind]), [[PRD, "Mario Kart PRD", "page"]]);
  assert.equal(found.results[0].editedAt, "2026-10-12T10:00:00.000Z");

  const page = (await call("GET", "/notion/page/:id", { params: { id: `Mario-Kart-PRD-${PRD}` } })) as NotionPage;
  assert.equal(page.title, "Mario Kart PRD");
  assert.deepEqual(page.properties, [
    { name: "Status", value: "Approved" },
    { name: "Owner", value: "Matthew" },
  ]);
  assert.deepEqual(
    page.blocks.map((b) => [b.type, b.text ?? b.title, b.checked]),
    [
      ["heading_1", "Goals", undefined],
      ["paragraph", "A browser kart racer with three tracks.", undefined],
      ["bulleted", "Time trials", undefined],
      ["todo", "Lap counter and timer", true],
      ["todo", "Drift boost tuning (MK-81)", false],
      ["code", "const CAP = 1.2;", undefined],
      ["callout", "Speed is capped", undefined],
      ["child_page", "Track list", undefined],
    ],
    "blank paragraphs and blocks without text (images) are left out",
  );
  assert.deepEqual(page.blocks[2].children?.map((b) => b.text), ["Ghost of your best lap"]);
  assert.equal(page.blocks[5].language, "typescript");
  assert.equal(page.blocks[6].icon, "⚠️");
  assert.equal(page.blocks[7].id, CHILD, "a child page's block id is the page to open");
  assert.equal(page.truncated, undefined);
});

test("the brain's text read is unchanged by the shared block walk", async () => {
  const notion = fakeNotion();
  seedPrd(notion);
  const text = await new Notion("secret", notion.fetchImpl).readPage(PRD);
  assert.match(text, /^# Mario Kart PRD\n.*\nStatus: Approved\nOwner: Matthew\n\n# Goals\nA browser kart racer/);
  assert.match(text, /- Time trials\n {2}- Ghost of your best lap\n- \[x\] Lap counter and timer/);
  assert.match(text, /\[page: Track list \(c2c2/);
});

test("a database reads as its rows; JARVIS Tasks and Memory are always pinned", async () => {
  const { dir, notion, call } = await setup();
  const ids = notionIdsFile(dir).get();
  await new NotionApi("secret", notion.fetchImpl).call("POST", "/pages", {
    parent: { database_id: ids.tasksDatabaseId },
    properties: { Name: { type: "title", title: [{ plain_text: "Renew passport" }] }, Status: { select: { name: "Open" } } },
  });
  const tasks = (await call("GET", "/notion/page/:id", { params: { id: ids.tasksDatabaseId! } })) as NotionPage;
  assert.equal(tasks.kind, "database");
  assert.deepEqual(tasks.blocks.map((b) => [b.type, b.title]), [["child_page", "Renew passport"]]);

  const pinned = (await call("GET", "/notion/pinned")) as NotionPinnedResponse;
  assert.deepEqual(pinned.pinned.map((p) => [p.title, p.kind, p.fixed]), [
    ["JARVIS Tasks", "database", true],
    ["JARVIS Memory", "page", true],
  ]);
  await assert.rejects(call("DELETE", "/notion/pinned/:id", { params: { id: ids.memoryPageId! } }), status(400));
});

test("pin and unpin are saved; recent keeps the last 10 opened, newest first, once each", async () => {
  const { dir, call } = await setup();
  await call("GET", "/notion/page/:id", { params: { id: CHILD } });
  await call("GET", "/notion/page/:id", { params: { id: PRD } });
  await call("GET", "/notion/page/:id", { params: { id: CHILD } });
  let state = (await call("GET", "/notion/pinned")) as NotionPinnedResponse;
  assert.deepEqual(state.recent.map((r) => r.title), ["Track list", "Mario Kart PRD"]);

  // The title comes from recent when the request doesn't say.
  state = (await call("POST", "/notion/pinned/:id", { params: { id: PRD } })) as NotionPinnedResponse;
  assert.deepEqual(state.pinned.map((p) => p.title), ["JARVIS Tasks", "JARVIS Memory", "Mario Kart PRD"]);
  state = (await call("POST", "/notion/pinned/:id", { params: { id: PRD }, body: { title: "Again" } })) as NotionPinnedResponse;
  assert.equal(state.pinned.length, 3, "pinning twice is a no-op");
  const saved = JSON.parse(readFileSync(join(dir, "notionDesk.json"), "utf8")) as { pins: { id: string }[] };
  assert.deepEqual(saved.pins.map((p) => p.id), [PRD]);

  state = (await call("POST", "/notion/pinned/:id/unpin", { params: { id: PRD } })) as NotionPinnedResponse;
  assert.equal(state.pinned.length, 2);
  await call("POST", "/notion/pinned/:id", { params: { id: CHILD }, body: { title: "Tracks", kind: "page" } });
  state = (await call("DELETE", "/notion/pinned/:id", { params: { id: PRD } })) as NotionPinnedResponse;
  assert.deepEqual(state.pinned.map((p) => p.title), ["JARVIS Tasks", "JARVIS Memory", "Tracks"]);

  // Never more than RECENT_MAX.
  const desk = new NotionDesk(dir, "secret", (async (url: string) =>
    new Response(JSON.stringify(url.includes("/children") ? { results: [] } : { object: "page", id: url.slice(-32), properties: {} }))) as unknown as typeof fetch);
  for (let i = 0; i < RECENT_MAX + 3; i++) await desk.page(String(i).padStart(32, "0"));
  assert.equal(desk.pinned().recent.length, RECENT_MAX);
  assert.equal(desk.pinned().recent[0].id, String(RECENT_MAX + 2).padStart(32, "0"));
});

test("bad ids, unknown pages and a missing token answer 400 / 404 / 400", async () => {
  const { call } = await setup();
  await assert.rejects(call("GET", "/notion/page/:id", { params: { id: "nope" } }), status(400));
  await assert.rejects(call("GET", "/notion/page/:id", { params: { id: "f".repeat(32) } }), status(404));
  const off = await setup({ connected: false });
  await assert.rejects(off.call("GET", "/notion/search", { url: new URL("http://x/?q=x") }), (e: Error & { status?: number }) => e.status === 400 && /NOTION_TOKEN/.test(e.message));
  // Pinned still lists what's saved without a token.
  assert.equal(((await off.call("GET", "/notion/pinned")) as NotionPinnedResponse).pinned.length, 2);
});
