// The conversational brain: Matthew talks in plain language, Claude decides what to do with
// JARVIS's tools (src/tools/, served by mcp.ts). Runs on the Claude subscription through the CLI in the container:
//   claude -p --model <m> --system-prompt <JARVIS> --tools "" --mcp-config <jarvis> --allowedTools …
// --tools "" removes every built-in tool (no shell, no files). The tool registry adds the rest: prompt
// hints, and which claude.ai connector tools are allowed or blocked (src/tools/connectors.ts); in -p
// mode anything not allowed is refused anyway.
// One conversation at a time, resumed across messages; "new conversation" starts a fresh one.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainMessage, BrainMetrics, Store } from "./store.js";
import type { BrainSetup } from "./tools/index.js";

const TIMEOUT_MS = 240_000;

/** The fixed part of the brain's system prompt; tool groups add their own hints (src/tools/). */
export const BASE_PROMPT = `You are JARVIS, Matthew's personal assistant. You run in his JARVIS container and he talks to you from Telegram or his dashboard, usually on his phone.

What you manage: Matthew builds software with Claude Code cloud sessions. Each project has an orchestrator session (named by ticket prefix, e.g. "mk" for Mario Kart) that runs builder sessions and reports progress; tickets, PRDs and docs live in Notion.`;

const ANSWER_STYLE = `How to answer: short and plain, for a phone screen. Lead with the answer. No headings, minimal lists, no filler. Times in his messages are UTC.`;

/** The full system prompt: base, every tool group's hints, any longer context, the answer style. */
export function systemPrompt(setup: Pick<BrainSetup, "hints" | "parts">): string {
  const work = ["How to work:", ...setup.hints, "- If a tool fails, say what failed in one line and what he can do."].join("\n");
  return [BASE_PROMPT, work, ...setup.parts, ANSWER_STYLE].join("\n\n");
}

const NO_TOOLS: BrainSetup = { hints: [], parts: [], allowedTools: [], disallowedTools: [], extraArgs: [] };

export interface BrainConfig {
  claudeBin: string;
  dataDir: string;
  models: string[];
  defaultModel: string;
  internalUrl: string;
  internalToken: string;
  /** What the tool registry adds (prompt hints, connector allow/deny lists, extra args); re-read per process. */
  setup?: () => Promise<BrainSetup>;
}

export interface BrainReply {
  reply: string;
  metrics: BrainMetrics;
}

interface CliResult {
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  session_id?: string;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
}

export function parseCliResult(stdout: string): CliResult | undefined {
  // --output-format json prints one JSON object; be lenient about stray lines before it.
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as CliResult & { type?: string };
      if (parsed && (parsed.type === "result" || "result" in parsed)) return parsed;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export class Brain {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cwd: string;
  private readonly mcpPath = fileURLToPath(new URL("./mcp.js", import.meta.url));

  constructor(
    private readonly config: BrainConfig,
    private readonly store: Store,
  ) {
    // An empty working directory: no CLAUDE.md or project settings leak into the brain.
    this.cwd = join(config.dataDir, "brain");
    mkdirSync(this.cwd, { recursive: true });
  }

  get model(): string {
    const chosen = this.store.brain().model;
    return chosen && this.config.models.includes(chosen) ? chosen : this.config.defaultModel;
  }

  get models(): string[] {
    return this.config.models;
  }

  setModel(model: string): void {
    if (!this.config.models.includes(model)) throw new Error(`Unknown model ${model}. Choose one of: ${this.config.models.join(", ")}`);
    this.store.updateBrain({ model });
  }

  /** Starts a fresh conversation; the next message no longer re-reads the old one. */
  reset(): void {
    this.store.updateBrain({ sessionId: undefined });
  }

  /** One message in, one reply out. Messages queue so the conversation stays in order. */
  chat(text: string, channel: BrainMessage["channel"]): Promise<BrainReply> {
    const run = this.queue.then(() => this.run(text, channel));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(text: string, channel: BrainMessage["channel"]): Promise<BrainReply> {
    const sentAt = new Date();
    this.store.addBrainMessage({ at: sentAt.toISOString(), from: "you", channel, text });
    const stamped = `[${sentAt.toISOString().slice(0, 16).replace("T", " ")} UTC, via ${channel}] ${text}`;

    let state = this.store.brain();
    let fresh = !state.sessionId;
    let sessionId = state.sessionId ?? randomUUID();
    let out = await this.invoke(stamped, sessionId, fresh);
    // A resumed conversation can be gone (volume reset, CLI cleanup): start over once.
    if (!fresh && (!out.result || out.result.is_error) && /no conversation found|not found/i.test(out.stderr + (out.result?.result ?? ""))) {
      fresh = true;
      sessionId = randomUUID();
      out = await this.invoke(stamped, sessionId, true);
    }
    if (!out.result) throw new Error(`The brain didn't answer: ${(out.stderr || "no output").trim().slice(0, 300)}`);
    if (fresh) this.store.updateBrain({ sessionId });

    const u = out.result.usage ?? {};
    const metrics: BrainMetrics = {
      ms: out.result.duration_ms ?? Date.now() - sentAt.getTime(),
      model: this.model,
      inputTokens: u.input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      turns: out.result.num_turns ?? 1,
      apiEquivalentUsd: out.result.total_cost_usd,
    };
    const reply = (out.result.result ?? "").trim() || (out.result.is_error ? "Something went wrong on my side." : "(no reply)");
    this.store.addBrainMessage({ at: new Date().toISOString(), from: "jarvis", channel, text: reply, metrics });
    return { reply, metrics };
  }

  private async invoke(prompt: string, sessionId: string, fresh: boolean): Promise<{ result?: CliResult; stderr: string }> {
    const setup = this.config.setup ? await this.config.setup() : NO_TOOLS;
    const mcpConfig = JSON.stringify({
      mcpServers: {
        jarvis: {
          type: "stdio",
          command: process.execPath,
          args: [this.mcpPath],
          env: { JARVIS_INTERNAL_URL: this.config.internalUrl, JARVIS_INTERNAL_TOKEN: this.config.internalToken },
        },
      },
    });
    const args = [
      "-p",
      "--output-format", "json",
      "--model", this.model,
      "--system-prompt", systemPrompt(setup),
      "--tools", "",
      // --strict-mcp-config also hides the claude.ai connectors, so it's only used when none are wanted.
      ...(setup.allowedTools.length ? [] : ["--strict-mcp-config"]),
      "--mcp-config", mcpConfig,
      "--allowedTools", ["mcp__jarvis", ...setup.allowedTools].join(","),
      ...(setup.disallowedTools.length ? ["--disallowedTools", setup.disallowedTools.join(",")] : []),
      ...setup.extraArgs,
      ...(fresh ? ["--session-id", sessionId] : ["--resume", sessionId]),
    ];
    return new Promise((resolve) => {
      const child = spawn(this.config.claudeBin, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stderr: err.message });
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve({ result: parseCliResult(stdout), stderr });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }
}

/** "⏱ 4.2s · 🔢 18.4k in (16k cached) · 212 out · sonnet" — the same metrics sessions report. */
export function formatMetrics(m: BrainMetrics): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const input = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
  const short = m.model.replace(/^claude-/, "").replace(/-\d.*$/, "");
  return `⏱ ${(m.ms / 1000).toFixed(1)}s · 🔢 ${k(input)} in (${k(m.cacheReadTokens)} cached) · ${k(m.outputTokens)} out · ${short}${m.turns > 1 ? ` · ${m.turns} steps` : ""}`;
}
