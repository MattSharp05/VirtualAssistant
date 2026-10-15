// Notion writes, fenced in: JARVIS may change only the JARVIS Memory page (its blocks) and the
// JARVIS Tasks database (its rows), both created by `npm run setup:notion` (setupNotion.ts) and
// saved in DATA_DIR/notion.json. Any other id is refused before a request is made (or, for a block
// or row, once its parent is checked). Reads of the two go through here too.

import { JsonFile } from "./storage.js";

const API = "https://api.notion.com/v1";
// Same as notion.ts: the version where /databases/{id}/query still exists.
export const NOTION_VERSION = "2022-06-28";

export type Json = Record<string, unknown>;

/** The two places JARVIS may write, saved by setup. */
export interface NotionIds {
  parentId?: string;
  memoryPageId?: string;
  tasksDatabaseId?: string;
}

export function notionIdsFile(dataDir: string): JsonFile<NotionIds> {
  return new JsonFile<NotionIds>(dataDir, "notion", {});
}

/** Notion ids compare without dashes, lowercase; links work too (the id is the last 32 hex chars). */
export function normalizeId(idOrUrl: string): string {
  const hex = idOrUrl.replace(/-/g, "").toLowerCase().match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/);
  return hex ? hex[0] : idOrUrl.replace(/-/g, "").toLowerCase();
}

export class NotionWriteRefused extends Error {}

/** A thin Notion REST client (all methods); used by setup and the writer. */
export class NotionApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Json): Promise<Json> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const hint =
        res.status === 404 ? " (not found, or not shared with the JARVIS integration)" : res.status === 403 ? " (the integration needs Insert and Update content)" : "";
      throw new Error(`Notion ${res.status}${hint}: ${String(json.message ?? "").slice(0, 200)}`);
    }
    return json;
  }
}

export class NotionWriter {
  constructor(
    private readonly api: NotionApi,
    private readonly ids: () => NotionIds,
  ) {}

  private allowed(): { memory?: string; tasks?: string } {
    const { memoryPageId, tasksDatabaseId } = this.ids();
    return { memory: memoryPageId && normalizeId(memoryPageId), tasks: tasksDatabaseId && normalizeId(tasksDatabaseId) };
  }

  private refuse(id: string, what: string): never {
    throw new NotionWriteRefused(
      `JARVIS only writes to the JARVIS Memory page and the JARVIS Tasks database; ${what} ${id} is neither` +
        (this.allowed().memory || this.allowed().tasks ? "." : " (run `npm run setup:notion` first)."),
    );
  }

  /** The Memory page itself. */
  private memoryPage(pageId: string): string {
    const id = normalizeId(pageId);
    if (!id || id !== this.allowed().memory) this.refuse(pageId, "page");
    return id;
  }

  /** The Tasks database itself. */
  private tasksDb(databaseId: string): string {
    const id = normalizeId(databaseId);
    if (!id || id !== this.allowed().tasks) this.refuse(databaseId, "database");
    return id;
  }

  /** A block that sits directly on the Memory page. */
  private async memoryBlock(blockId: string): Promise<string> {
    const block = await this.api.call("GET", `/blocks/${normalizeId(blockId)}`);
    const parent = (block.parent ?? {}) as Json;
    if (!this.allowed().memory || normalizeId(String(parent.page_id ?? "")) !== this.allowed().memory) this.refuse(blockId, "block");
    return normalizeId(blockId);
  }

  /** A row (page) of the Tasks database. */
  private async taskRow(pageId: string): Promise<string> {
    const page = await this.api.call("GET", `/pages/${normalizeId(pageId)}`);
    const parent = (page.parent ?? {}) as Json;
    if (!this.allowed().tasks || normalizeId(String(parent.database_id ?? "")) !== this.allowed().tasks) this.refuse(pageId, "page");
    return normalizeId(pageId);
  }

  // ── Memory page ──

  async getPage(pageId: string): Promise<Json> {
    return this.api.call("GET", `/pages/${this.memoryPage(pageId)}`);
  }

  async listBlocks(pageId: string): Promise<Json[]> {
    const id = this.memoryPage(pageId);
    const out: Json[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.api.call("GET", `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
      out.push(...((res.results as Json[]) ?? []));
      cursor = res.has_more ? String(res.next_cursor) : undefined;
    } while (cursor);
    return out;
  }

  /** Appends at the end, or right after block `after` (which must be on the page). */
  async appendBlocks(pageId: string, children: Json[], after?: string): Promise<Json[]> {
    const id = this.memoryPage(pageId);
    const res = await this.api.call("PATCH", `/blocks/${id}/children`, { children, ...(after ? { after: normalizeId(after) } : {}) });
    return (res.results as Json[]) ?? [];
  }

  async updateBlock(blockId: string, body: Json): Promise<Json> {
    return this.api.call("PATCH", `/blocks/${await this.memoryBlock(blockId)}`, body);
  }

  async deleteBlock(blockId: string): Promise<void> {
    await this.api.call("DELETE", `/blocks/${await this.memoryBlock(blockId)}`);
  }

  // ── Tasks database ──

  async queryRows(databaseId: string, body: Json = {}): Promise<Json[]> {
    const id = this.tasksDb(databaseId);
    const out: Json[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.api.call("POST", `/databases/${id}/query`, { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) });
      out.push(...((res.results as Json[]) ?? []));
      cursor = res.has_more ? String(res.next_cursor) : undefined;
    } while (cursor && out.length < 500);
    return out;
  }

  /** A new row; `children` are blocks for the row's own page (e.g. why a suggestion was made). */
  async createRow(databaseId: string, properties: Json, children?: Json[]): Promise<Json> {
    const id = this.tasksDb(databaseId);
    return this.api.call("POST", "/pages", { parent: { database_id: id }, properties, ...(children?.length ? { children } : {}) });
  }

  async updateRow(pageId: string, properties: Json): Promise<Json> {
    return this.api.call("PATCH", `/pages/${await this.taskRow(pageId)}`, { properties });
  }
}
