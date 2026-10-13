// Read-only Notion access for the brain, through a Notion internal integration (NOTION_TOKEN).
// It sees only the pages and databases you've shared with the integration.

const API = "https://api.notion.com/v1";
// The stable API version for /databases/{id}/query; later versions moved databases to data sources.
const VERSION = "2022-06-28";
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

export class Notion {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string, body?: Json): Promise<Json> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
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

  async readPage(id: string): Promise<string> {
    const page = await this.call(`/pages/${encodeURIComponent(id)}`);
    const props = Object.entries((page.properties ?? {}) as Record<string, Json>)
      .filter(([, p]) => p.type !== "title")
      .map(([name, p]) => [name, propertyText(p)])
      .filter(([, v]) => v)
      .map(([name, v]) => `${name}: ${v}`);
    const lines: string[] = [];
    let count = 0;
    const walk = async (blockId: string, depth: number): Promise<void> => {
      let cursor: string | undefined;
      do {
        const res = await this.call(`/blocks/${encodeURIComponent(blockId)}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
        for (const block of (res.results as Json[]) ?? []) {
          if (++count > MAX_BLOCKS) return;
          const line = blockText(block, depth);
          if (line) lines.push(line);
          if (block.has_children && depth < 2 && block.type !== "child_page" && block.type !== "child_database") {
            await walk(String(block.id), depth + 1);
          }
        }
        cursor = res.has_more ? String(res.next_cursor) : undefined;
      } while (cursor && count <= MAX_BLOCKS);
    };
    await walk(id, 0);
    let text = [`# ${titleOf(page)}`, String(page.url ?? ""), ...props, "", ...lines].join("\n");
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n… (truncated)`;
    return text;
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
