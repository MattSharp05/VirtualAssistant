// JARVIS's tools for the brain, as a minimal MCP server over stdio (newline-delimited JSON-RPC).
// The brain's `claude -p` process starts this; every tool is a call to the main JARVIS process's
// internal API (JARVIS_INTERNAL_URL + JARVIS_INTERNAL_TOKEN), so one process owns all state.

import { createInterface } from "node:readline";

const BASE = process.env.JARVIS_INTERNAL_URL ?? "http://127.0.0.1:8080";
const TOKEN = process.env.JARVIS_INTERNAL_TOKEN ?? "";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<string>;
}

async function internal(path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${BASE}/internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.text ?? "";
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

export const TOOLS: Tool[] = [
  {
    name: "overview",
    description:
      "Current state: Claude login, plan usage (5-hour and weekly), routine fires, the sessions JARVIS tracks (name, kind, link) and their latest reports. Start here for any status question.",
    inputSchema: schema({}),
    call: () => internal("/overview"),
  },
  {
    name: "list_cloud_sessions",
    description: "All of Matthew's active Claude Code cloud sessions (title, status, last activity, id), newest first.",
    inputSchema: schema({}),
    call: () => internal("/sessions"),
  },
  {
    name: "session_activity",
    description:
      "What a session has been doing lately: its recent messages and tool use, read from the session's history. target = a tracked name (e.g. mk, j3) or a session id (cse_…/session_…). Use it for 'what is X doing'.",
    inputSchema: schema({ target: str("Tracked name or session id"), limit: int("How many recent items (default 15)") }, ["target"]),
    call: (a) => internal(`/activity?target=${encodeURIComponent(String(a.target ?? ""))}&limit=${Number(a.limit ?? 15)}`),
  },
  {
    name: "send_to_session",
    description:
      "Send Matthew's instruction to a cloud session (an orchestrator or builder). target = tracked name or session id. Write the message as Matthew would, clear and self-contained. The session answers via a report later.",
    inputSchema: schema({ target: str("Tracked name or session id"), message: str("The instruction to send") }, ["target", "message"]),
    call: (a) => internal("/send", { target: a.target, message: a.message }),
  },
  {
    name: "start_session",
    description: "Start a new cloud session on a task (fires the JARVIS routine: uses one of 30 fires per hour and plan usage).",
    inputSchema: schema({ task: str("The task, written as a complete instruction") }, ["task"]),
    call: (a) => internal("/start", { task: a.task }),
  },
  {
    name: "notion_search",
    description: "Search Matthew's Notion (pages and databases shared with the JARVIS integration) by title text. Returns titles and ids.",
    inputSchema: schema({ query: str("Words to search for") }, ["query"]),
    call: (a) => internal(`/notion/search?q=${encodeURIComponent(String(a.query ?? ""))}`),
  },
  {
    name: "notion_read_page",
    description: "Read a Notion page's properties and content as text. page_id comes from notion_search or a link.",
    inputSchema: schema({ page_id: str("Notion page id") }, ["page_id"]),
    call: (a) => internal(`/notion/page?id=${encodeURIComponent(String(a.page_id ?? ""))}`),
  },
  {
    name: "notion_query_database",
    description: "List rows of a Notion database (e.g. a project's Tickets) with their properties (status, wave, …).",
    inputSchema: schema({ database_id: str("Notion database id"), limit: int("Max rows (default 25)") }, ["database_id"]),
    call: (a) => internal("/notion/query", { database_id: a.database_id, limit: a.limit ?? 25 }),
  },
];

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

export async function handle(msg: Rpc): Promise<Record<string, unknown> | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "jarvis", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return reply({ content: [{ type: "text", text: `Unknown tool ${String(msg.params?.name)}` }], isError: true });
      try {
        const text = await tool.call((msg.params?.arguments ?? {}) as Record<string, unknown>);
        return reply({ content: [{ type: "text", text: text || "(empty)" }] });
      } catch (err) {
        return reply({ content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true });
      }
    }
    default:
      // Notifications (no id) need no answer; unknown requests get "method not found".
      return msg.id === undefined ? undefined : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } };
  }
}

// Run as a stdio server when executed directly (not when imported by tests).
if (process.argv[1]?.endsWith("mcp.js")) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    void handle(msg).then((out) => {
      if (out) process.stdout.write(JSON.stringify(out) + "\n");
    });
  });
}
