// Lists your Claude Code cloud sessions, for the dashboard's session picker and Telegram's /sessions.
//
// UNDOCUMENTED, and contained like plan usage: there is no public "list my cloud sessions" API.
// Two routes, tried in order, both using the container's own `claude auth login`:
//   1. `claude agents --json` — a documented scripting command whose list includes cloud sessions
//      when the account has cloud access (its "agents:cloud" section).
//   2. GET /v1/code/sessions — the endpoint the CLI's own teleport picker calls, with the OAuth
//      access token the CLI keeps in CLAUDE_CONFIG_DIR. Running route 1 first also lets the CLI
//      refresh that token if it has expired.
// Anything that fails returns { available: false, reason } and nothing else breaks.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CloudSession {
  id: string;
  title: string;
  status?: string;
  lastActivityAt?: string;
  url: string;
}

export interface SessionList {
  available: boolean;
  sessions: CloudSession[];
  source?: "agents" | "api";
  reason?: string;
  checkedAt: string;
}

const SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]+$/;
const API = "https://api.anthropic.com/v1/code/sessions?limit=100";

function toIso(value: unknown): string | undefined {
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

function byRecent(a: CloudSession, b: CloudSession): number {
  return (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "");
}

/** Cloud rows from `claude agents --json` (local rows have UUID session IDs and are skipped). */
export function parseAgentsJson(text: string): CloudSession[] {
  const rows = JSON.parse(text) as Record<string, unknown>[];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): CloudSession | undefined => {
      const id = String(r.sessionId ?? r.id ?? "");
      if (!SESSION_ID.test(id)) return undefined;
      return {
        id,
        title: String(r.title ?? r.name ?? id),
        status: typeof r.status === "string" ? r.status : undefined,
        lastActivityAt: toIso(r.lastEventAt ?? r.last_event_at ?? r.updatedAt ?? r.startedAt),
        url: `https://claude.ai/code/${id}`,
      };
    })
    .filter((s): s is CloudSession => s !== undefined)
    .sort(byRecent);
}

/** Rows from GET /v1/code/sessions, filtered the way the CLI's picker filters them. */
export function parseApiPage(body: { data?: Record<string, unknown>[] }): CloudSession[] {
  return (body.data ?? [])
    .filter((r) => {
      const id = String(r.id ?? "");
      const title = String(r.title ?? "").trim();
      return (
        SESSION_ID.test(id) &&
        r.status !== "archived" &&
        r.environment_kind !== "bridge" &&
        title !== "" &&
        title !== "__warming__" &&
        !title.includes("__CBU_POOLED__")
      );
    })
    .map((r) => ({
      id: String(r.id),
      title: String(r.title).trim(),
      status: typeof r.status === "string" ? r.status : undefined,
      lastActivityAt: toIso(r.last_event_at ?? r.created_at),
      url: `https://claude.ai/code/${String(r.id)}`,
    }))
    .sort(byRecent);
}

function runAgents(claudeBin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, ["agents", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim() || `claude agents exited ${code}`));
    });
  });
}

function readAccessToken(configDir: string): string | undefined {
  try {
    const creds = JSON.parse(readFileSync(join(configDir, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return creds.claudeAiOauth?.accessToken;
  } catch {
    return undefined;
  }
}

export async function listCloudSessions(
  claudeBin: string,
  configDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude"),
  fetchImpl: typeof fetch = fetch,
): Promise<SessionList> {
  const checkedAt = new Date().toISOString();
  const reasons: string[] = [];

  try {
    const sessions = parseAgentsJson(await runAgents(claudeBin));
    if (sessions.length) return { available: true, sessions, source: "agents", checkedAt };
    reasons.push("`claude agents --json` listed no cloud sessions");
  } catch (err) {
    reasons.push(`claude agents failed: ${(err as Error).message.slice(0, 120)}`);
  }

  const token = readAccessToken(configDir);
  if (!token) {
    reasons.push("no claude.ai login found (run: docker compose run --rm jarvis claude auth login)");
    return { available: false, sessions: [], reason: reasons.join("; "), checkedAt };
  }
  try {
    const res = await fetchImpl(API, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      reasons.push(`session list API answered HTTP ${res.status}`);
      return { available: false, sessions: [], reason: reasons.join("; "), checkedAt };
    }
    const sessions = parseApiPage((await res.json()) as { data?: Record<string, unknown>[] });
    return { available: true, sessions, source: "api", checkedAt };
  } catch (err) {
    reasons.push(`session list API failed: ${(err as Error).message.slice(0, 120)}`);
    return { available: false, sessions: [], reason: reasons.join("; "), checkedAt };
  }
}

/** Keeps the dashboard and Telegram from spawning the CLI on every refresh. */
export class SessionListCache {
  private last?: SessionList;
  private pending?: Promise<SessionList>;

  constructor(
    private readonly claudeBin: string,
    private readonly maxAgeMs = 60_000,
  ) {}

  async get(force = false): Promise<SessionList> {
    if (!force && this.last && Date.now() - Date.parse(this.last.checkedAt) < this.maxAgeMs) return this.last;
    this.pending ??= listCloudSessions(this.claudeBin).finally(() => (this.pending = undefined));
    this.last = await this.pending;
    return this.last;
  }
}
