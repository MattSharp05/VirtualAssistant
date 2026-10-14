// The tool registry. Every file in this folder that default-exports a ToolGroup (types.ts) is a group;
// they're discovered at startup, so a new tool is a new file. The registry serves:
//   - the MCP server (mcp.ts, via the internal API in web.ts): tool list and calls,
//   - the brain (brain.ts): system-prompt hints and extra CLI arguments.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isToolGroup, type CliContribution, type JsonSchema, type ToolContext, type ToolDef, type ToolGroup } from "./types.js";

export type { ToolContext, ToolGroup } from "./types.js";

/** What the brain's CLI gets from all groups together. */
export interface BrainSetup {
  /** Hints for the system prompt, one block per group that has one. */
  hints: string[];
  /** Longer context (e.g. memory) for the system prompt. */
  parts: string[];
  allowedTools: string[];
  disallowedTools: string[];
  extraArgs: string[];
  /** Built-in tools to enable (default none). */
  builtinTools?: string[];
  /** Permission allow rules for them. */
  allowRules?: string[];
  /** Only these JARVIS tools (by name) instead of all of them (the worker brain). */
  jarvisTools?: string[];
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const NOT_GROUPS = new Set(["index", "types", "core"]);

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDef>();

  constructor(readonly groups: ToolGroup[]) {
    for (const g of groups) {
      for (const t of g.tools) {
        if (this.byName.has(t.name)) throw new Error(`Duplicate tool name ${t.name} (group ${g.name})`);
        this.byName.set(t.name, t);
      }
    }
  }

  /** Imports every group file next to this one (compiled .js), sorted by file name. */
  static async discover(dir = dirname(fileURLToPath(import.meta.url))): Promise<ToolRegistry> {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".js") && !NOT_GROUPS.has(f.slice(0, -3)))
      .sort();
    const groups: ToolGroup[] = [];
    for (const file of files) {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown };
      if (isToolGroup(mod.default)) groups.push(mod.default);
    }
    return new ToolRegistry(groups);
  }

  list(): ToolInfo[] {
    return [...this.byName.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.byName.get(name);
    if (!tool) throw new UnknownToolError(name);
    return tool.handler(args ?? {}, ctx);
  }

  async brainSetup(ctx: ToolContext): Promise<BrainSetup> {
    const setup: BrainSetup = { hints: [], parts: [], allowedTools: [], disallowedTools: [], extraArgs: [], builtinTools: [], allowRules: [] };
    for (const g of this.groups) {
      const hint = typeof g.promptHint === "function" ? g.promptHint(ctx) : g.promptHint;
      if (hint) setup.hints.push(hint);
      const part = g.promptParts ? await g.promptParts(ctx) : undefined;
      if (part) setup.parts.push(part);
      const cli: CliContribution = (typeof g.cli === "function" ? g.cli(ctx) : g.cli) ?? {};
      setup.allowedTools.push(...(cli.allowedTools ?? []));
      setup.disallowedTools.push(...(cli.disallowedTools ?? []));
      setup.extraArgs.push(...(cli.extraArgs ?? []));
      setup.builtinTools!.push(...(cli.builtinTools ?? []));
      setup.allowRules!.push(...(cli.allowRules ?? []));
    }
    return setup;
  }
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool ${name}`);
  }
}
