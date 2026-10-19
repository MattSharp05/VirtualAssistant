// Talks to existing cloud sessions through the Claude Code CLI installed in the container.
// `claude -p --cloud <session-id>` queues one message into the session and exits; it needs a
// one-time `claude auth login` with the claude.ai account (a setup-token is not enough).
// Docs: https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli
//
// New sessions (JD-69) are created with POST /v1/code/sessions, the sessions API the CLI's own
// cloud commands use, with the same login as the session list (sessions.ts). UNDOCUMENTED: checked
// on 2026-10-19 that it makes a normal session (sidebar, title, tags, repo, environment); the
// field for the first message is a best guess, so sessionStart.ts falls back to sending it with
// `claude -p --cloud <id>`. (`claude -p --cloud "<task>"` can't create one: --cloud with --print is
// for existing sessions only.)

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { API_BASE, apiHeaders, claudeConfigDir, readAccessToken, readOrganizationUuid } from "./claudeApi.js";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(bin: string, args: string[], stdin?: string, timeoutMs = 90_000, cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${bin} ${args[0]} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // The message goes in on stdin, never argv, so text starting with "-" can't be read as a flag.
    // If the CLI exits before reading it, the write fails with EPIPE; the exit code and stderr
    // already tell the story, so the stream error must not crash JARVIS.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

export interface SendResult {
  ok: boolean;
  sessionId?: string;
  url?: string;
  error?: string;
}

export async function sendToSession(claudeBin: string, sessionId: string, message: string): Promise<SendResult> {
  const { code, stdout, stderr } = await run(
    claudeBin,
    ["-p", "--cloud", sessionId, "--output-format", "json"],
    message,
  );
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(line) as { ok: boolean; session_id?: string; url?: string; error?: string };
    return { ok: parsed.ok, sessionId: parsed.session_id, url: parsed.url, error: parsed.error };
  } catch {
    // Configuration errors (not logged in, policy off) print to stderr without JSON.
    return { ok: false, error: (stderr || stdout).trim() || `claude exited with code ${code}` };
  }
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  detail: string;
  /** Set when the login probably can't drive cloud sessions. */
  warning?: string;
}

export async function authStatus(claudeBin: string): Promise<AuthStatus> {
  try {
    const { stdout, stderr } = await run(claudeBin, ["auth", "status", "--json"], undefined, 30_000);
    const text = stdout.trim();
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const loggedIn = parsed.loggedIn === true;
      const authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod : undefined;
      const detail = [parsed.email, parsed.subscriptionType, authMethod].filter(Boolean).join(", ") || text;
      // A setup-token (CLAUDE_CODE_OAUTH_TOKEN) or API key logs in for model calls, but cloud
      // sessions need a full claude.ai sign-in from `claude auth login`.
      const warning =
        loggedIn && authMethod && /oauth_token|api_key/i.test(authMethod)
          ? `Signed in via ${authMethod}; --cloud needs \`claude auth login\` with your claude.ai account. Unset CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY and log in.`
          : undefined;
      return { loggedIn, authMethod, detail, warning };
    } catch {
      return { loggedIn: false, detail: (text || stderr).trim() };
    }
  } catch (err) {
    return { loggedIn: false, detail: (err as Error).message };
  }
}

// ── Creating sessions (JD-69) ──

export interface NewSession {
  title: string;
  /** The first user message; omitted = an empty session to message afterwards. */
  prompt?: string;
  /** The GitHub repo's URL, e.g. https://github.com/MattSharp05/VirtualAssistant. */
  repoUrl?: string;
  /** env_…; omitted = the account's default environment. */
  environmentId?: string;
  tags: string[];
}

export class CreateSessionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The request body, shaped after a live session record: title, environment, sources, tags, first message. */
export function createSessionBody(s: NewSession): Record<string, unknown> {
  return {
    title: s.title,
    ...(s.environmentId ? { environment_id: s.environmentId } : {}),
    session_context: { sources: s.repoUrl ? [{ git_repository: { url: s.repoUrl } }] : [] },
    tags: s.tags,
    // The first message as a transcript event (the shape the events endpoint returns). Unverified.
    ...(s.prompt
      ? { events: [{ type: "event", data: { uuid: randomUUID(), session_id: "", type: "user", parent_tool_use_id: null, message: { role: "user", content: s.prompt } } }] }
      : {}),
  };
}

export interface ApiDeps {
  fetchImpl?: typeof fetch;
  configDir?: string;
}

function login(configDir: string): Record<string, string> {
  const token = readAccessToken(configDir);
  if (!token) throw new CreateSessionError("no claude.ai login found (run: docker compose run --rm jarvis claude auth login)");
  return apiHeaders(token, readOrganizationUuid(configDir));
}

/** Creates a normal cloud session; throws CreateSessionError (with the HTTP status when there was one). */
export async function createCloudSession(s: NewSession, deps: ApiDeps = {}): Promise<{ sessionId: string; url: string }> {
  const headers = login(deps.configDir ?? claudeConfigDir());
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${API_BASE}/v1/code/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(createSessionBody(s)),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new CreateSessionError(`session create failed: ${(err as Error).message.slice(0, 160)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new CreateSessionError(`session create answered HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
  let id: unknown;
  try {
    const body = JSON.parse(text) as { id?: unknown; session?: { id?: unknown } };
    id = body.id ?? body.session?.id;
  } catch {
    // handled below
  }
  if (typeof id !== "string" || !/^(?:session|cse)_/.test(id)) throw new CreateSessionError(`session create returned no session id: ${text.slice(0, 200)}`);
  return { sessionId: id, url: `https://claude.ai/code/${id}` };
}

/** Sets a session's title (the one-off rename of older routine sessions). Unverified endpoint: a refusal is reported, not thrown. */
export async function renameCloudSession(sessionId: string, title: string, deps: ApiDeps = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${API_BASE}/v1/code/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: login(deps.configDir ?? claudeConfigDir()),
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 160) };
  }
}
