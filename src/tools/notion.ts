// Notion, read-only: search, read pages, list database rows.
import { core } from "./sessions.js";
import { int, schema, str, type ToolGroup } from "./types.js";

const group: ToolGroup = {
  name: "notion",
  promptHint: "- Notion pages are read-only for you: search, read pages, list database rows (the to-do list has its own task tools).",
  tools: [
    {
      name: "notion_search",
      description:
        "Search Matthew's Notion (pages and databases shared with the JARVIS integration) by title text. Returns titles and ids.",
      inputSchema: schema({ query: str("Words to search for") }, ["query"]),
      handler: (a, ctx) => core(ctx).notionSearch(String(a.query ?? "")),
    },
    {
      name: "notion_read_page",
      description: "Read a Notion page's properties and content as text. page_id comes from notion_search or a link.",
      inputSchema: schema({ page_id: str("Notion page id") }, ["page_id"]),
      handler: (a, ctx) => core(ctx).notionPage(String(a.page_id ?? "")),
    },
    {
      name: "notion_query_database",
      description: "List rows of a Notion database (e.g. a project's Tickets) with their properties (status, wave, …).",
      inputSchema: schema({ database_id: str("Notion database id"), limit: int("Max rows (default 25)") }, ["database_id"]),
      handler: (a, ctx) => core(ctx).notionQuery(String(a.database_id ?? ""), Number(a.limit ?? 25)),
    },
  ],
};

export default group;
