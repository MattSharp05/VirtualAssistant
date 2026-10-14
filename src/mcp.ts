// JARVIS's tools for the brain, as a minimal MCP server over stdio (newline-delimited JSON-RPC).
// The brain's `claude -p` process starts this; the tool list and every call go to the main JARVIS
// process's internal API (JARVIS_INTERNAL_URL + JARVIS_INTERNAL_TOKEN), which serves the tool
// registry (src/tools/), so one process owns all state and adding a tool never touches this file.

import { createInterface } from "node:readline";

const BASE = process.env.JARVIS_INTERNAL_URL ?? "http://127.0.0.1:8080";
const TOKEN = process.env.JARVIS_INTERNAL_TOKEN ?? "";

interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function internal(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `HTTP ${res.status}`));
  return json;
}

// The list comes from JARVIS's tool registry (src/tools/), fetched once per brain process.
let toolList: Promise<ToolInfo[]> | undefined;
export function listTools(): Promise<ToolInfo[]> {
  toolList ??= internal("/tools").then((j) => (j.tools as ToolInfo[]) ?? []);
  toolList.catch(() => (toolList = undefined));
  return toolList;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const json = await internal(`/tool/${encodeURIComponent(name)}`, { args });
  return String(json.text ?? "");
}

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
      try {
        return reply({ tools: await listTools() });
      } catch (err) {
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `JARVIS unreachable: ${(err as Error).message}` } };
      }
    case "tools/call": {
      try {
        const text = await callTool(String(msg.params?.name ?? ""), (msg.params?.arguments ?? {}) as Record<string, unknown>);
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
