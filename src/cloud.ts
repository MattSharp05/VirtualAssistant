// Talks to existing cloud sessions through the Claude Code CLI installed in the container.
// `claude -p --cloud <session-id>` queues one message into the session and exits; it needs a
// one-time `claude auth login` with the claude.ai account (a setup-token is not enough).
// Docs: https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli

import { spawn } from "node:child_process";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], stdin?: string, timeoutMs = 90_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
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
