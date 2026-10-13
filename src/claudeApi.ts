// The container's own claude.ai login, for the undocumented cloud-session endpoints the CLI itself
// uses (session list, session history). Read-only: JARVIS never writes or refreshes these files;
// the CLI does that whenever it runs.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const API_BASE = "https://api.anthropic.com";

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude");
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function readAccessToken(configDir = claudeConfigDir()): string | undefined {
  const creds = readJson(join(configDir, ".credentials.json")) as { claudeAiOauth?: { accessToken?: string } } | undefined;
  return creds?.claudeAiOauth?.accessToken;
}

/** The organization the login belongs to; the history endpoint wants it as a header. */
export function readOrganizationUuid(configDir = claudeConfigDir()): string | undefined {
  // With CLAUDE_CONFIG_DIR set the CLI keeps .claude.json inside it; otherwise in $HOME.
  for (const path of [join(configDir, ".claude.json"), join(process.env.HOME ?? "", ".claude.json")]) {
    const uuid = (readJson(path)?.oauthAccount as { organizationUuid?: string } | undefined)?.organizationUuid;
    if (uuid) return uuid;
  }
  return undefined;
}

export function apiHeaders(token: string, organizationUuid?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
    ...(organizationUuid ? { "x-organization-uuid": organizationUuid } : {}),
  };
}
