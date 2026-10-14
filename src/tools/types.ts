// What a tool group is. Each file in src/tools/ (except this one, index.ts and core.ts) default-exports
// a ToolGroup and is picked up automatically by the registry (index.ts): adding tools = adding a file.

import type { Config } from "../config.js";
import type { DeskContext } from "../desk/routes/index.js";
import type { Jarvis } from "../jarvis.js";

/** What a tool handler can use. One per process; built in index.ts. */
export interface ToolContext {
  jarvis: Jarvis;
  config: Config;
  /** The Desk API: its live stream and server→Mac requests (absent in some tests). */
  desk?: DeskContext;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Returns text the model reads. Throwing reports the message to the model as a tool error. */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

/** What a group adds to the brain's `claude -p` command line. */
export interface CliContribution {
  /** Extra --allowedTools entries (e.g. claude.ai connector tools). */
  allowedTools?: string[];
  /** --disallowedTools entries. */
  disallowedTools?: string[];
  /** Any other CLI arguments. */
  extraArgs?: string[];
}

export interface ToolGroup {
  name: string;
  tools: ToolDef[];
  /** A short instruction added to the brain's system prompt (how and when to use these tools). */
  promptHint?: string | ((ctx: ToolContext) => string | undefined);
  /** Longer context added to the system prompt at conversation start (e.g. memory). */
  promptParts?: (ctx: ToolContext) => Promise<string | undefined>;
  cli?: CliContribution | ((ctx: ToolContext) => CliContribution);
}

export function isToolGroup(value: unknown): value is ToolGroup {
  const v = value as ToolGroup | undefined;
  return !!v && typeof v.name === "string" && Array.isArray(v.tools);
}

export const str = (description: string) => ({ type: "string", description });
export const int = (description: string) => ({ type: "integer", description });
export const schema = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
});
