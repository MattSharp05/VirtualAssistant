// What a cloud session has been doing lately, read from its history.
//
// UNDOCUMENTED, and contained like the session list: GET /v1/code/sessions/{id}/teleport-events is
// what `claude --teleport` reads (paged, oldest first, 1000 per page). The event shape isn't
// published, so the reader below only looks for message text and tool names wherever they sit,
// and anything unexpected degrades to { available: false, reason }.

import { API_BASE, apiHeaders, readAccessToken, readOrganizationUuid } from "./claudeApi.js";

export interface ActivityItem {
  at?: string;
  role: "user" | "assistant" | "tool" | "other";
  text: string;
}

export interface SessionActivity {
  available: boolean;
  items: ActivityItem[];
  reason?: string;
}

const MAX_PAGES = 5;
const MAX_TEXT = 600;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

/** Turns one raw history event into a readable line, or undefined for noise (hooks, progress, …). */
export function describeEvent(raw: Record<string, unknown>): ActivityItem | undefined {
  // Events seen in the wild wrap the transcript entry in `payload`; accept it bare too.
  const event = (raw.payload && typeof raw.payload === "object" ? raw.payload : raw) as Record<string, unknown>;
  const at = typeof (raw.created_at ?? event.timestamp) === "string" ? String(raw.created_at ?? event.timestamp) : undefined;
  const type = String(event.type ?? "");
  const message = (event.message ?? {}) as { role?: string; content?: unknown };
  const content = message.content ?? event.content;

  if (type === "result" && typeof event.result === "string") return { at, role: "assistant", text: clip(`(turn finished) ${event.result}`) };
  if (type !== "user" && type !== "assistant") return undefined;

  const parts: string[] = [];
  const tools: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      if (block.type === "tool_use" && typeof block.name === "string") tools.push(block.name);
    }
  }
  if (parts.length) return { at, role: type, text: clip(parts.join(" ")) };
  if (tools.length) return { at, role: "tool", text: `used ${tools.join(", ")}` };
  return undefined; // tool results and other plumbing
}

export async function sessionActivity(sessionId: string, limit = 15, fetchImpl: typeof fetch = fetch): Promise<SessionActivity> {
  const token = readAccessToken();
  if (!token) return { available: false, items: [], reason: "no claude.ai login in the container" };
  const headers = apiHeaders(token, readOrganizationUuid());
  const url = `${API_BASE}/v1/code/sessions/${encodeURIComponent(sessionId)}/teleport-events`;

  const items: ActivityItem[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchImpl(`${url}?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { available: false, items: [], reason: `session history answered HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Record<string, unknown>[]; events?: Record<string, unknown>[]; next_cursor?: string | null };
      for (const raw of body.data ?? body.events ?? []) {
        const item = describeEvent(raw);
        if (item) items.push(item);
      }
      cursor = body.next_cursor ?? undefined;
      if (!cursor) break;
    }
  } catch (err) {
    return { available: false, items: [], reason: `session history failed: ${(err as Error).message.slice(0, 120)}` };
  }
  if (!items.length) return { available: false, items: [], reason: "no readable messages in the session history" };
  return { available: true, items: items.slice(-limit) };
}
