// Read-only Notion access for the brain, through a Notion internal integration (NOTION_TOKEN).
// It sees only the pages and databases you've shared with the integration.

import type { NotionBlock, NotionBlockType, NotionPage, NotionPageRef } from "@jarvis/shared";
import { normalizeId } from "./notionWrite.js";

const API = "https://api.notion.com/v1";
// The stable API version for /databases/{id}/query; later versions moved databases to data sources.
const VERSION = "2022-06-28";
// Data sources (collection://… ids) are only queryable from this version on.
const DATA_SOURCES_VERSION = "2025-09-03";
const MAX_BLOCKS = 400;
const MAX_CHARS = 15_000;

type Json = Record<string, unknown>;

function plain(rich: unknown): string {
  return Array.isArray(rich) ? rich.map((r) => String((r as Json).plain_text ?? "")).join("") : "";
}

export function titleOf(page: Json): string {
  if (Array.isArray(page.title)) return plain(page.title) || "Untitled"; // databases
  for (const prop of Object.values((page.properties ?? {}) as Record<string, Json>)) {
    if (prop.type === "title") return plain(prop.title) || "Untitled";
  }
  return "Untitled";
}

/** One property value as short text (status, select, dates, people, …). */
export function propertyText(prop: Json): string {
  const v = prop[String(prop.type)] as unknown;
  switch (prop.type) {
    case "title":
    case "rich_text":
      return plain(v);
    case "select":
    case "status":
      return String((v as Json | null)?.name ?? "");
    case "multi_select":
      return Array.isArray(v) ? v.map((o) => String((o as Json).name)).join(", ") : "";
    case "date":
      return v ? [String((v as Json).start ?? ""), (v as Json).end ? String((v as Json).end) : ""].filter(Boolean).join(" → ") : "";
    case "checkbox":
      return v ? "yes" : "no";
    case "number":
      return v === null || v === undefined ? "" : String(v);
    case "url":
    case "email":
    case "phone_number":
      return String(v ?? "");
    case "people":
      return Array.isArray(v) ? v.map((p) => String((p as Json).name ?? "")).join(", ") : "";
    case "relation":
      return Array.isArray(v) ? `${v.length} linked` : "";
    case "formula":
      return propertyText({ type: (v as Json)?.type, ...(v as Json) });
    default:
      return "";
  }
}

/** A block as one line of markdown-ish text. */
export function blockText(block: Json, depth: number): string | undefined {
  const type = String(block.type);
  const body = (block[type] ?? {}) as Json;
  const text = plain(body.rich_text);
  const indent = "  ".repeat(depth);
  switch (type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
    case "toggle":
      return `${indent}- ${text}`;
    case "numbered_list_item":
      return `${indent}1. ${text}`;
    case "to_do":
      return `${indent}- [${body.checked ? "x" : " "}] ${text}`;
    case "quote":
    case "callout":
      return `> ${text}`;
    case "code":
      return "```\n" + text + "\n```";
    case "divider":
      return "---";
    case "child_page":
      return `[page: ${String(body.title ?? "")} (${String(block.id)})]`;
    case "child_database":
      return `[database: ${String(body.title ?? "")} (${String(block.id)})]`;
    case "paragraph":
      return text ? `${indent}${text}` : undefined;
    default:
      return text ? `${indent}${text}` : undefined;
  }
}

/** Notion's block types as the Desk's (JD-34); others are dropped unless they hold text (→ paragraph). */
const BLOCK_TYPES: Record<string, NotionBlockType> = {
  heading_1: "heading_1",
  heading_2: "heading_2",
  heading_3: "heading_3",
  paragraph: "paragraph",
  bulleted_list_item: "bulleted",
  numbered_list_item: "numbered",
  to_do: "todo",
  toggle: "toggle",
  quote: "quote",
  callout: "callout",
  code: "code",
  divider: "divider",
  child_page: "child_page",
  child_database: "child_database",
};

/** A raw block and the blocks under it, as read (two levels below the page at most). */
export interface BlockNode {
  block: Json;
  children: BlockNode[];
}

/** A block as structured JSON for the Desk's read view (JD-34). */
export function blockJson(node: BlockNode): NotionBlock | undefined {
  const { block } = node;
  const raw = String(block.type);
  const body = (block[raw] ?? {}) as Json;
  const text = plain(body.rich_text);
  const type = BLOCK_TYPES[raw] ?? (text ? "paragraph" : undefined);
  if (!type) return undefined;
  const children = node.children.map(blockJson).filter((b): b is NotionBlock => Boolean(b));
  if (type === "paragraph" && !text && !children.length) return undefined; // blank lines
  const out: NotionBlock = { id: normalizeId(String(block.id)), type };
  if (type === "child_page" || type === "child_database") out.title = String(body.title ?? "") || "Untitled";
  else if (type !== "divider") out.text = text;
  if (type === "todo") out.checked = Boolean(body.checked);
  if (type === "code" && body.language) out.language = String(body.language);
  if (type === "callout" && (body.icon as Json | undefined)?.emoji) out.icon = String((body.icon as Json).emoji);
  if (children.length) out.children = children;
  return out;
}

/** A search result, pin or database row as a NotionPageRef. */
export function pageRef(obj: Json): NotionPageRef {
  return {
    id: normalizeId(String(obj.id)),
    title: titleOf(obj),
    kind: obj.object === "database" ? "database" : "page",
    ...(obj.url ? { url: String(obj.url) } : {}),
    ...(obj.last_edited_time ? { editedAt: String(obj.last_edited_time) } : {}),
  };
}

export class Notion {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string, body?: Json, version = VERSION): Promise<Json> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": version, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const hint = res.status === 404 ? " (not found, or not shared with the JARVIS integration)" : "";
      throw new Error(`Notion ${res.status}${hint}: ${String(json.message ?? "").slice(0, 200)}`);
    }
    return json;
  }

  async search(query: string, limit = 10): Promise<string> {
    const res = await this.call("/search", { query, page_size: limit });
    const rows = (res.results as Json[]) ?? [];
    if (!rows.length) return `No Notion pages match "${query}" (only pages shared with the integration are searchable).`;
    return rows
      .map((r) => `- ${r.object === "database" ? "[database] " : ""}${titleOf(r)} (id ${String(r.id)}, edited ${String(r.last_edited_time ?? "").slice(0, 10)})`)
      .join("\n");
  }

  /** A page's blocks, two levels deep, at most MAX_BLOCKS of them. */
  private async blockTree(id: string): Promise<{ nodes: BlockNode[]; truncated: boolean }> {
    let count = 0;
    const walk = async (blockId: string, depth: number): Promise<BlockNode[]> => {
      const nodes: BlockNode[] = [];
      let cursor: string | undefined;
      do {
        const res = await this.call(`/blocks/${encodeURIComponent(blockId)}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
        for (const block of (res.results as Json[]) ?? []) {
          if (++count > MAX_BLOCKS) return nodes;
          const node: BlockNode = { block, children: [] };
          nodes.push(node);
          if (block.has_children && depth < 2 && block.type !== "child_page" && block.type !== "child_database") {
            node.children = await walk(String(block.id), depth + 1);
          }
        }
        cursor = res.has_more ? String(res.next_cursor) : undefined;
      } while (cursor && count <= MAX_BLOCKS);
      return nodes;
    };
    const nodes = await walk(id, 0);
    return { nodes, truncated: count > MAX_BLOCKS };
  }

  private static props(page: Json): { name: string; value: string }[] {
    return Object.entries((page.properties ?? {}) as Record<string, Json>)
      .filter(([, p]) => p.type !== "title")
      .map(([name, p]) => ({ name, value: propertyText(p) }))
      .filter((p) => p.value);
  }

  async readPage(id: string): Promise<string> {
    const page = await this.call(`/pages/${encodeURIComponent(id)}`);
    const props = Notion.props(page).map((p) => `${p.name}: ${p.value}`);
    const lines: string[] = [];
    const flatten = (nodes: BlockNode[], depth: number) => {
      for (const node of nodes) {
        const line = blockText(node.block, depth);
        if (line) lines.push(line);
        flatten(node.children, depth + 1);
      }
    };
    flatten((await this.blockTree(id)).nodes, 0);
    let text = [`# ${titleOf(page)}`, String(page.url ?? ""), ...props, "", ...lines].join("\n");
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n… (truncated)`;
    return text;
  }

  /** Pages and databases matching `query` for the Desk (JD-34); an empty query lists recently edited ones. */
  async searchPages(query: string, limit = 20): Promise<NotionPageRef[]> {
    const res = await this.call("/search", { ...(query ? { query } : {}), page_size: limit });
    return ((res.results as Json[]) ?? []).map(pageRef);
  }

  /**
   * A page as structured JSON for the Desk's read view (JD-34). A database reads as its first 100
   * rows, each a child_page block, so it opens like a page of links.
   */
  async readPageJson(id: string): Promise<NotionPage> {
    let page: Json;
    try {
      page = await this.call(`/pages/${encodeURIComponent(id)}`);
    } catch (err) {
      // /pages/{id} refuses a database id (400); try it as one before giving up.
      try {
        page = await this.call(`/databases/${encodeURIComponent(id)}`);
      } catch {
        throw err;
      }
    }
    const ref = pageRef(page);
    if (ref.kind === "database") {
      const res = await this.call(`/databases/${encodeURIComponent(id)}/query`, { page_size: 100 });
      const rows = ((res.results as Json[]) ?? []).map((row) => ({ id: normalizeId(String(row.id)), type: "child_page" as const, title: titleOf(row) }));
      return { ...ref, properties: [], blocks: rows, ...(res.has_more ? { truncated: true } : {}) };
    }
    const { nodes, truncated } = await this.blockTree(id);
    const blocks = nodes.map(blockJson).filter((b): b is NotionBlock => Boolean(b));
    return { ...ref, properties: Notion.props(page), blocks, ...(truncated ? { truncated } : {}) };
  }

  /** A page as Notion returns it (title, url, properties); the agent graph's run pages (JD-57). */
  rawPage(id: string): Promise<Json> {
    return this.call(`/pages/${encodeURIComponent(normalizeId(id))}`);
  }

  /** A page's blocks two levels deep, as Notion returns them: a table comes with its rows. */
  async rawBlocks(id: string): Promise<BlockNode[]> {
    return (await this.blockTree(normalizeId(id))).nodes;
  }

  /**
   * Rows matching `filter`, up to `max`, from a data source ("collection://…", read with the data
   * sources API) or a database id. Read only, like everything here.
   */
  async queryRows(source: string, filter: Json, max = 200): Promise<Json[]> {
    const dataSource = source.startsWith("collection://");
    const id = encodeURIComponent(dataSource ? source.slice("collection://".length) : normalizeId(source));
    const rows: Json[] = [];
    let cursor: string | undefined;
    do {
      const body = { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const res = dataSource ? await this.call(`/data_sources/${id}/query`, body, DATA_SOURCES_VERSION) : await this.call(`/databases/${id}/query`, body);
      rows.push(...((res.results as Json[]) ?? []));
      cursor = res.has_more && res.next_cursor ? String(res.next_cursor) : undefined;
    } while (cursor && rows.length < max);
    return rows.slice(0, max);
  }

  async queryDatabase(id: string, limit = 25): Promise<string> {
    const res = await this.call(`/databases/${encodeURIComponent(id)}/query`, { page_size: Math.min(limit, 100) });
    const rows = (res.results as Json[]) ?? [];
    if (!rows.length) return "The database has no rows (or none are shared with the integration).";
    return rows
      .map((row) => {
        const props = Object.entries((row.properties ?? {}) as Record<string, Json>)
          .filter(([, p]) => p.type !== "title")
          .map(([name, p]) => [name, propertyText(p)])
          .filter(([, v]) => v)
          .map(([name, v]) => `${name}: ${v}`)
          .join(" · ");
        return `- ${titleOf(row)} (id ${String(row.id)})${props ? ` — ${props}` : ""}`;
      })
      .join("\n");
  }
}

export interface NotionStatus {
  /** off: no NOTION_TOKEN · ok: token accepted · rejected: Notion refused the token · error: couldn't reach Notion. */
  state: "off" | "ok" | "rejected" | "error";
  /** Pages and databases shared with the integration ("100+" past the first page). */
  shared?: string;
  detail?: string;
}

/**
 * Checks the token against Notion: every 5 minutes when it works and sees pages, every minute
 * otherwise (so sharing a page or fixing the token shows up quickly).
 */
export class NotionStatusCache {
  private cached?: { value: NotionStatus; at: number };
  private pending?: Promise<NotionStatus>;

  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(): Promise<NotionStatus> {
    if (!this.token) return { state: "off" };
    const settled = this.cached?.value.state === "ok" && this.cached.value.shared !== "0";
    const ttl = settled ? 300_000 : 60_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.value;
    this.pending ??= this.check().then((value) => {
      this.cached = { value, at: Date.now() };
      this.pending = undefined;
      return value;
    });
    return this.pending;
  }

  private async check(): Promise<NotionStatus> {
    try {
      const res = await this.fetchImpl(`${API}/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({ page_size: 100 }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json().catch(() => ({}))) as Json;
      if (res.status === 401) return { state: "rejected", detail: "Notion rejected NOTION_TOKEN; copy the Internal Integration Secret again." };
      if (!res.ok) return { state: "error", detail: `Notion ${res.status}: ${String(json.message ?? "").slice(0, 120)}` };
      const count = ((json.results as Json[]) ?? []).length;
      return { state: "ok", shared: json.has_more ? "100+" : String(count) };
    } catch (err) {
      return { state: "error", detail: `Couldn't reach Notion: ${(err as Error).message}` };
    }
  }
}
