// Starts new cloud sessions through the Claude Code Routines API trigger.
// Docs: https://code.claude.com/docs/en/routines and
// https://platform.claude.com/docs/en/api/claude-code/routines-fire
// Fires bill against the Claude subscription, not API credits. Limit: 30 fires/hour per routine.

const API_BASE = "https://api.anthropic.com/v1/claude_code/routines";

export interface FiredSession {
  sessionId: string;
  url: string;
}

export class RoutineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function fireRoutine(
  routineId: string,
  token: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FiredSession> {
  const res = await fetchImpl(`${API_BASE}/${encodeURIComponent(routineId)}/fire`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const body = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? " (check ROUTINE_TOKEN; generating a new token revokes the old one)"
        : res.status === 429
          ? ` (rate limited; retry after ${res.headers.get("retry-after") ?? "a while"}s)`
          : "";
    throw new RoutineError(`Routine fire failed: HTTP ${res.status}${hint}: ${body.slice(0, 300)}`, res.status);
  }

  const data = JSON.parse(body) as { claude_code_session_id?: string; claude_code_session_url?: string };
  if (!data.claude_code_session_id) {
    throw new RoutineError(`Routine fire returned no session id: ${body.slice(0, 300)}`);
  }
  return {
    sessionId: data.claude_code_session_id,
    url: data.claude_code_session_url ?? `https://claude.ai/code/${data.claude_code_session_id}`,
  };
}
