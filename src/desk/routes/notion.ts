// The Notion window (JD-34; mockup 7): search, pinned and recent pages, and one page as structured
// blocks for the read view.
//   GET    /api/desk/notion/search?q=      → NotionSearchResponse (pages and databases shared with JARVIS)
//   GET    /api/desk/notion/page/:id       → NotionPage (and it goes to the top of recent)
//   GET    /api/desk/notion/pinned         → NotionPinnedResponse (JARVIS Tasks + Memory, pins, last 10 opened)
//   POST   /api/desk/notion/pinned/:id { title?, kind? } → pins it
//   DELETE /api/desk/notion/pinned/:id (or POST …/:id/unpin) → unpins it
// Reads only: pins and recent live in DATA_DIR/notionDesk.json, never in Notion.
import type { NotionPage, NotionPageRef, NotionPinnedResponse, NotionSearchResponse } from "@jarvis/shared";
import { JarvisError } from "../../jarvis.js";
import { acceptanceChecklist, Notion } from "../../notion.js";
import { normalizeId, notionIdsFile } from "../../notionWrite.js";
import { JsonFile } from "../../storage.js";
import { DeskHttpError, type DeskContext, type DeskRoute } from "./index.js";

export const RECENT_MAX = 10;
const ID = /^[0-9a-f]{32}$/;

interface NotionDeskFile {
  pins: NotionPageRef[];
  recent: NotionPageRef[];
}

const notionUrl = (id: string) => `https://www.notion.so/${id}`;

/** The Notion window's server side: reads through src/notion.ts, pins and recent in a JsonFile. */
export class NotionDesk {
  private readonly file: JsonFile<NotionDeskFile>;
  private readonly notion?: Notion;

  constructor(
    private readonly dataDir: string,
    token: string | undefined,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.file = new JsonFile<NotionDeskFile>(dataDir, "notionDesk", { pins: [], recent: [] });
    this.notion = token ? new Notion(token, fetchImpl) : undefined;
  }

  private api(): Notion {
    if (!this.notion) throw new JarvisError("Notion isn't connected: NOTION_TOKEN is not set in JARVIS's .env.");
    return this.notion;
  }

  /** JARVIS Tasks and JARVIS Memory, once `npm run setup:notion` has made them. */
  private fixed(): NotionPageRef[] {
    const ids = notionIdsFile(this.dataDir).get();
    const out: NotionPageRef[] = [];
    if (ids.tasksDatabaseId) {
      const id = normalizeId(ids.tasksDatabaseId);
      out.push({ id, title: "JARVIS Tasks", kind: "database", url: notionUrl(id), fixed: true });
    }
    if (ids.memoryPageId) {
      const id = normalizeId(ids.memoryPageId);
      out.push({ id, title: "JARVIS Memory", kind: "page", url: notionUrl(id), fixed: true });
    }
    return out;
  }

  search(query: string): Promise<NotionPageRef[]> {
    return this.api().searchPages(query.trim());
  }

  async page(id: string): Promise<NotionPage> {
    const page = await this.api().readPageJson(id);
    const ref: NotionPageRef = { id: page.id, title: page.title, kind: page.kind, ...(page.url ? { url: page.url } : {}), ...(page.editedAt ? { editedAt: page.editedAt } : {}) };
    await this.file.update((f) => ({ ...f, recent: [ref, ...f.recent.filter((r) => r.id !== ref.id)].slice(0, RECENT_MAX) }));
    return page;
  }

  /** A ticket's Acceptance Criteria checklist (the To-do window's QA panel, JD-83). Read-only. */
  async qaChecklist(ticketUrlOrId: string): Promise<{ text: string; checked: boolean }[]> {
    const page = await this.api().readPageJson(normalizeId(ticketUrlOrId));
    return acceptanceChecklist(page.blocks);
  }

  pinned(): NotionPinnedResponse {
    const fixed = this.fixed();
    const pins = this.file.get().pins.filter((p) => !fixed.some((f) => f.id === p.id));
    return { pinned: [...fixed, ...pins], recent: this.file.get().recent };
  }

  /** Pins a page; its title comes from the request, recent, or Notion. */
  async pin(id: string, given: { title?: string; kind?: NotionPageRef["kind"] }): Promise<NotionPinnedResponse> {
    const { pins, recent } = this.file.get();
    if (this.fixed().some((f) => f.id === id) || pins.some((p) => p.id === id)) return this.pinned();
    let ref = recent.find((r) => r.id === id);
    if (given.title) ref = { id, title: given.title, kind: given.kind ?? ref?.kind ?? "page", url: ref?.url ?? notionUrl(id) };
    ref ??= (({ blocks: _b, properties: _p, truncated: _t, ...r }) => r)(await this.api().readPageJson(id));
    const pin = ref;
    await this.file.update((f) => ({ ...f, pins: [...f.pins, pin] }));
    return this.pinned();
  }

  async unpin(id: string): Promise<NotionPinnedResponse> {
    if (this.fixed().some((f) => f.id === id)) throw new DeskHttpError(400, "JARVIS Tasks and JARVIS Memory are always pinned.");
    await this.file.update((f) => ({ ...f, pins: f.pins.filter((p) => p.id !== id) }));
    return this.pinned();
  }
}

const services = new WeakMap<object, NotionDesk>();

export function notionDeskFor(ctx: DeskContext): NotionDesk {
  let s = services.get(ctx.jarvis);
  if (!s) services.set(ctx.jarvis, (s = new NotionDesk(ctx.jarvis.config.dataDir, ctx.jarvis.config.notionToken)));
  return s;
}

/** Tests put an instance with a fake Notion in place. */
export function useNotionDesk(owner: object, service: NotionDesk): void {
  services.set(owner, service);
}

/** A page id from the path: 32 hex chars, with or without dashes (a notion.so link works too). */
function pageId(raw: string): string {
  const id = normalizeId(raw);
  if (!ID.test(id)) throw new DeskHttpError(400, "id must be a Notion page id");
  return id;
}

/** Not set up → 400 with what to do; Notion's 404 → 404; anything else from Notion → 502. */
export async function notionFriendly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof JarvisError) throw new DeskHttpError(400, err.message);
    if (err instanceof DeskHttpError) throw err;
    const message = (err as Error).message;
    if (/^Notion 404/.test(message)) throw new DeskHttpError(404, message);
    if (/^Notion \d+/.test(message)) throw new DeskHttpError(502, message);
    throw err;
  }
}

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/notion/search",
    handler: async ({ url, ctx }): Promise<NotionSearchResponse> => {
      const query = url.searchParams.get("q") ?? "";
      return { query, results: await notionFriendly(() => notionDeskFor(ctx).search(query)) };
    },
  },
  {
    method: "GET",
    path: "/notion/page/:id",
    handler: ({ params, ctx }) => notionFriendly(() => notionDeskFor(ctx).page(pageId(params.id))),
  },
  { method: "GET", path: "/notion/pinned", handler: ({ ctx }) => notionDeskFor(ctx).pinned() },
  {
    method: "POST",
    path: "/notion/pinned/:id",
    handler: ({ params, body, ctx }) =>
      notionFriendly(() =>
        notionDeskFor(ctx).pin(pageId(params.id), {
          ...(typeof body.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}),
          ...(body.kind === "database" || body.kind === "page" ? { kind: body.kind } : {}),
        }),
      ),
  },
  { method: "DELETE", path: "/notion/pinned/:id", handler: ({ params, ctx }) => notionFriendly(() => notionDeskFor(ctx).unpin(pageId(params.id))) },
  { method: "POST", path: "/notion/pinned/:id/unpin", handler: ({ params, ctx }) => notionFriendly(() => notionDeskFor(ctx).unpin(pageId(params.id))) },
];

export default routes;
