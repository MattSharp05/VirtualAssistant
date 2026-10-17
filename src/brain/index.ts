// The conversational brain: Matthew talks in plain language, Claude decides what to do with
// JARVIS's tools (src/tools/, served by mcp.ts). Runs on the Claude subscription through the CLI in the container:
//   claude -p --model <m> --system-prompt <JARVIS> --tools "" --mcp-config <jarvis> --allowedTools …
// --tools "" removes every built-in tool (no shell, no files). The tool registry adds the rest: prompt
// hints, and which claude.ai connector tools are allowed or blocked (src/tools/connectors.ts); in -p
// mode anything not allowed is refused anyway.
// One conversation at a time, resumed across messages; "new conversation" starts a fresh one.
//
// Warm mode (default; ADR 0003, warm.ts): one CLI process stays up for the conversation and streams
// its reply. It restarts on a model change, a new conversation, a crash or 30 min idle, re-reading the
// tool registry's setup (prompt parts such as memory) each time. BRAIN_WARM=0 spawns one process per
// message like before. Either way the reply is published on the event bus as brain.* events.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainChannel, BrainMetrics, ChatStep } from "@jarvis/shared";
import type { EventBus } from "../events.js";
import type { BrainMessage, BrainState } from "../store.js";
import type { BrainSetup } from "../tools/index.js";
import { WarmExitError, WarmProcess } from "./warm.js";

const TIMEOUT_MS = 240_000;
const IDLE_MS = 30 * 60_000;

/** The fixed part of the brain's system prompt; tool groups add their own hints (src/tools/). */
export const BASE_PROMPT = `You are JARVIS, Matthew's personal assistant. You run in his JARVIS container and he talks to you from Telegram or his dashboard, usually on his phone.

What you manage: Matthew builds software with Claude Code cloud sessions. Each project has an orchestrator session (named by ticket prefix, e.g. "mk" for Mario Kart) that runs builder sessions and reports progress; tickets, PRDs and docs live in Notion.`;

const ANSWER_STYLE = `How to answer: short and plain, for a phone screen. Lead with the answer. No headings, minimal lists, no filler. Each message starts with the date and time in his time zone; use it for "today", "Friday", "in an hour".`;

/** "[Tue 14 Oct 2026 23:20 Europe/London (UTC+01:00), via telegram]": the brain's clock, in Matthew's zone. */
export function stamp(at: Date, channel: string, timeZone = process.env.TZ || "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const offset = get("timeZoneName").replace("GMT", "UTC") || "UTC";
  return `[${get("weekday")} ${get("day")} ${get("month")} ${get("year")} ${get("hour")}:${get("minute")} ${timeZone} (${offset === "UTC" ? "UTC+00:00" : offset}), via ${channel}]`;
}

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
  /** What the tool registry adds (prompt hints, prompt parts, connector allow/deny lists, extra args); re-read per process. */
  setup?: () => Promise<BrainSetup>;
  /** Keep one streaming CLI process per conversation (default true; BRAIN_WARM=0 turns it off). */
  warm?: boolean;
  /** Where brain.* and orb.state events go (the Desk's live stream). The worker has none. */
  bus?: EventBus;
  /** Folder name under dataDir (its own CLI project, so conversations never mix). Default "brain". */
  name?: string;
  /** The system prompt from the registry's setup (default: JARVIS's chat prompt). */
  prompt?: (setup: BrainSetup) => string;
  /** How long one turn may take (default 240 s; a browser task's turn runs many steps, JD-60). */
  timeoutMs?: number;
}

/** Where a brain keeps its conversation id, model, messages and usage totals (Store for the chat). */
export interface BrainStateStore {
  brain(): BrainState;
  updateBrain(patch: Partial<Omit<BrainState, "messages" | "totals">>): void;
  addBrainMessage(message: BrainMessage): void;
}

export type { BrainChannel };

export interface BrainReply {
  messageId: string;
  reply: string;
  metrics: BrainMetrics;
}

/** One tool call the brain made, for features that react to them (calendar change log, uploads). */
export interface BrainToolEvent {
  messageId: string;
  phase: "call" | "result";
  name: string;
  input: unknown;
  summary?: string;
  isError?: boolean;
  /** The tool result's full text (results only; up to 20k characters). Not sent to the Desk. */
  result?: string;
}

export interface ChatOptions {
  /** Each chunk of reply text as it's written. */
  onDelta?: (text: string) => void;
  /** Files that came with the message (src/uploads.ts); the brain can Read them. */
  attachments?: { path: string; name: string }[];
  /** Use this message id instead of a new one (a caller that must hand it back before queueing). */
  messageId?: string;
  /** This turn's model (one of `models`; JD-48's voiceModel), instead of the chosen one. A warm process on another model restarts, resuming the conversation. */
  model?: string;
}

export interface CliResult {
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

const GONE = /no conversation found|not found/i;

export class Brain {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cwd: string;
  private readonly mcpPath = fileURLToPath(new URL("../mcp.js", import.meta.url));
  private readonly toolListeners = new Set<(e: BrainToolEvent) => void>();
  /** The tools used so far by each turn in flight, kept with the reply (chat window chips). */
  private readonly steps = new Map<string, ChatStep[]>();
  private proc?: WarmProcess;
  /** A warm process being started (its setup is read first). */
  private starting?: Promise<WarmProcess>;
  private idleTimer?: NodeJS.Timeout;
  /** Turns in flight (warm mode); a restart waits for 0. */
  private busy = 0;
  private restartPending = false;
  /** How many CLI processes this brain has started (tests and the dashboard read it). */
  spawns = 0;

  constructor(
    private readonly config: BrainConfig,
    private readonly store: BrainStateStore,
  ) {
    // An empty working directory: no CLAUDE.md or project settings leak into the brain.
    this.cwd = join(config.dataDir, config.name ?? "brain");
    mkdirSync(this.cwd, { recursive: true });
    // Memory is part of the system prompt, which a warm process reads once: restart to pick changes up.
    config.bus?.subscribe((e) => {
      if (e.type === "memory.changed") this.restartWhenIdle();
    });
  }

  /** Stops the warm process now if idle, else right after the current turn; the next message starts a fresh one. */
  restartWhenIdle(): void {
    if (!this.proc) return;
    if (this.busy === 0) this.stop();
    else this.restartPending = true;
  }

  get model(): string {
    const chosen = this.store.brain().model;
    return chosen && this.config.models.includes(chosen) ? chosen : this.config.defaultModel;
  }

  get models(): string[] {
    return this.config.models;
  }

  get warm(): boolean {
    return this.config.warm !== false;
  }

  /**
   * Starts the warm process now if it isn't running (JD-48: the Desk calls this when Matthew starts
   * talking, so a process that idled out or restarted for memory is up again by the time he's done).
   * Does nothing in cold mode, or while a turn is running.
   */
  async prewarm(model = this.model): Promise<boolean> {
    if (!this.warm || this.busy > 0 || this.restartPending || !this.config.models.includes(model)) return false;
    while (this.starting) await this.starting.catch(() => undefined);
    const before = this.proc;
    const proc = await this.process(model);
    if (proc === before) return false;
    this.armIdle();
    return true;
  }

  setModel(model: string): void {
    if (!this.config.models.includes(model)) throw new Error(`Unknown model ${model}. Choose one of: ${this.config.models.join(", ")}`);
    this.store.updateBrain({ model });
  }

  /** Starts a fresh conversation; the next message no longer re-reads the old one. */
  reset(): void {
    this.store.updateBrain({ sessionId: undefined, conversationStartedAt: new Date().toISOString() });
    this.stop();
  }

  /** Stops the warm process (shutdown, reset). The next message starts a new one. */
  stop(): void {
    clearTimeout(this.idleTimer);
    this.proc?.kill();
    this.proc = undefined;
  }

  /** Calls `fn` for every tool call and result; returns an unsubscribe function. */
  onTool(fn: (e: BrainToolEvent) => void): () => void {
    this.toolListeners.add(fn);
    return () => this.toolListeners.delete(fn);
  }

  /** One message in, one reply out. Messages queue so the conversation stays in order. */
  chat(text: string, channel: BrainChannel, options: ChatOptions = {}): Promise<BrainReply> {
    return this.start(text, channel, options).done;
  }

  /** Like chat(), but hands back the message id at once (the Desk follows the reply over SSE). */
  start(text: string, channel: BrainChannel, options: ChatOptions = {}): { messageId: string; done: Promise<BrainReply> } {
    const messageId = options.messageId ?? randomUUID();
    const done = this.queue.then(() => this.run(messageId, text, channel, options));
    this.queue = done.catch(() => undefined);
    return { messageId, done };
  }

  private publish(event: Parameters<EventBus["publish"]>[0]): void {
    this.config.bus?.publish(event);
  }

  private async run(messageId: string, text: string, channel: BrainChannel, options: ChatOptions): Promise<BrainReply> {
    const sentAt = new Date();
    const model = options.model && this.config.models.includes(options.model) ? options.model : this.model;
    this.store.addBrainMessage({ at: sentAt.toISOString(), from: "you", channel, text });
    this.publish({ type: "brain.start", messageId, channel, text });
    this.publish({ type: "orb.state", state: "thinking" });
    const attached = (options.attachments ?? []).map((a) => `\nAttached: ${a.path} (${a.name})`).join("");
    const stamped = `${stamp(sentAt, channel)} ${text}${attached}`;
    const onDelta = (chunk: string) => {
      options.onDelta?.(chunk);
      this.publish({ type: "brain.delta", messageId, text: chunk });
    };
    try {
      const result = this.warm ? await this.runWarm(messageId, stamped, onDelta, model) : await this.runOnce(stamped, model);
      const u = result.usage ?? {};
      const metrics: BrainMetrics = {
        ms: result.duration_ms ?? Date.now() - sentAt.getTime(),
        model,
        inputTokens: u.input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        turns: result.num_turns ?? 1,
        apiEquivalentUsd: result.total_cost_usd,
      };
      const reply = (result.result ?? "").trim() || (result.is_error ? "Something went wrong on my side." : "(no reply)");
      const steps = this.steps.get(messageId);
      this.store.addBrainMessage({ at: new Date().toISOString(), from: "jarvis", channel, text: reply, metrics, ...(steps?.length ? { steps } : {}) });
      this.publish({ type: "brain.done", messageId, text: reply, metrics });
      return { messageId, reply, metrics };
    } catch (err) {
      this.publish({ type: "brain.error", messageId, error: (err as Error).message });
      throw err;
    } finally {
      this.steps.delete(messageId);
      this.publish({ type: "orb.state", state: "idle" });
    }
  }

  // ── Warm: one streaming process per conversation ──

  private async runWarm(messageId: string, prompt: string, onDelta: (t: string) => void, model: string): Promise<CliResult> {
    const tools = new Map<string, { name: string; input: unknown }>();
    const handlers = {
      onDelta,
      onToolCall: (id: string, name: string, input: unknown) => {
        tools.set(id, { name, input });
        this.toolEvent({ messageId, phase: "call", name, input });
      },
      onToolResult: (id: string, summary: string, isError: boolean, result: string) => {
        const call = tools.get(id);
        this.toolEvent({ messageId, phase: "result", name: call?.name ?? "unknown", input: call?.input, summary, isError, result });
      },
    };
    for (let attempt = 0; ; attempt++) {
      const proc = await this.process(model);
      this.busy++;
      try {
        const result = await withTimeout(proc.send(prompt, handlers), this.config.timeoutMs ?? TIMEOUT_MS, () => proc.kill());
        if (!this.store.brain().sessionId) this.store.updateBrain({ sessionId: proc.sessionId });
        this.armIdle();
        return result;
      } catch (err) {
        if (this.proc === proc) this.proc = undefined;
        if (!(err instanceof WarmExitError) || attempt >= 1) {
          if (err instanceof WarmExitError) throw new Error(`The brain didn't answer: ${(err.stderr || err.message).trim().slice(0, 300)}`);
          throw err;
        }
        // The conversation it tried to resume is gone (volume reset, CLI cleanup): start over.
        if (GONE.test(err.stderr)) this.store.updateBrain({ sessionId: undefined });
        // Otherwise it crashed: the retry resumes the same conversation in a new process.
      } finally {
        this.busy--;
        if (this.restartPending && this.busy === 0) {
          this.restartPending = false;
          this.stop();
        }
      }
    }
  }

  /** The warm process for `model` and the current conversation, started if needed. */
  private async process(model: string): Promise<WarmProcess> {
    // One start at a time: a prewarm and a turn arriving together share the process it starts.
    while (this.starting) await this.starting.catch(() => undefined);
    const state = this.store.brain();
    const p = this.proc;
    const stale =
      !p || !p.alive || p.model !== model || (state.sessionId !== undefined && p.sessionId !== state.sessionId) || Date.now() - p.lastUsed > IDLE_MS;
    if (!stale) return p;
    p?.kill();
    const fresh = !state.sessionId;
    const sessionId = state.sessionId ?? randomUUID();
    const start = (async () => {
      const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...(await this.args(sessionId, fresh, model))];
      this.spawns++;
      this.proc = new WarmProcess(this.config.claudeBin, args, this.cwd, model, sessionId);
      return this.proc;
    })();
    this.starting = start;
    try {
      return await start;
    } finally {
      this.starting = undefined;
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
    this.idleTimer.unref();
  }

  private toolEvent(e: BrainToolEvent): void {
    this.publish({ type: "brain.tool", messageId: e.messageId, phase: e.phase, name: e.name, input: e.input, summary: e.summary, isError: e.isError });
    if (e.phase === "result") {
      const steps = this.steps.get(e.messageId) ?? [];
      steps.push({ name: e.name, ...(e.summary ? { summary: e.summary } : {}), ...(e.isError ? { isError: true } : {}) });
      this.steps.set(e.messageId, steps);
    }
    for (const fn of this.toolListeners) {
      try {
        fn(e);
      } catch (err) {
        console.error(`brain tool listener failed on ${e.name}:`, err);
      }
    }
  }

  // ── Cold (BRAIN_WARM=0): one process per message ──

  private async runOnce(prompt: string, model: string): Promise<CliResult> {
    const state = this.store.brain();
    let fresh = !state.sessionId;
    let sessionId = state.sessionId ?? randomUUID();
    let out = await this.invoke(prompt, sessionId, fresh, model);
    // A resumed conversation can be gone (volume reset, CLI cleanup): start over once.
    if (!fresh && (!out.result || out.result.is_error) && GONE.test(out.stderr + (out.result?.result ?? ""))) {
      fresh = true;
      sessionId = randomUUID();
      out = await this.invoke(prompt, sessionId, true, model);
    }
    if (!out.result) throw new Error(`The brain didn't answer: ${(out.stderr || "no output").trim().slice(0, 300)}`);
    if (fresh) this.store.updateBrain({ sessionId });
    return out.result;
  }

  private async invoke(prompt: string, sessionId: string, fresh: boolean, model: string): Promise<{ result?: CliResult; stderr: string }> {
    const args = ["--output-format", "json", ...(await this.args(sessionId, fresh, model))];
    this.spawns++;
    return new Promise((resolve) => {
      const child = spawn(this.config.claudeBin, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), this.config.timeoutMs ?? TIMEOUT_MS);
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

  /** Everything after `-p` except the output format: model, prompt, tools, conversation. */
  private async args(sessionId: string, fresh: boolean, model = this.model): Promise<string[]> {
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
    return [
      "-p",
      "--model", model,
      "--system-prompt", (this.config.prompt ?? systemPrompt)(setup),
      // Built-in tools stay off except what a group asks for (uploads: Read, limited by allowRules).
      "--tools", (setup.builtinTools ?? []).join(","),
      ...(setup.allowRules?.length ? ["--settings", JSON.stringify({ permissions: { allow: setup.allowRules } })] : []),
      // --strict-mcp-config also hides the claude.ai connectors, so it's only used when none are wanted.
      ...(setup.allowedTools.length ? [] : ["--strict-mcp-config"]),
      "--mcp-config", mcpConfig,
      // Every JARVIS tool, or just the named ones (the worker).
      "--allowedTools", [...(setup.jarvisTools ? setup.jarvisTools.map((t) => `mcp__jarvis__${t}`) : ["mcp__jarvis"]), ...setup.allowedTools].join(","),
      ...(setup.disallowedTools.length ? ["--disallowedTools", setup.disallowedTools.join(",")] : []),
      ...setup.extraArgs,
      ...(fresh ? ["--session-id", sessionId] : ["--resume", sessionId]),
    ];
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`The brain took longer than ${ms / 1000}s and was stopped.`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** "⏱ 4.2s · 🔢 18.4k in (16k cached) · 212 out · sonnet" — the same metrics sessions report. */
export function formatMetrics(m: BrainMetrics): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const input = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
  const short = m.model.replace(/^claude-/, "").replace(/-\d.*$/, "");
  return `⏱ ${(m.ms / 1000).toFixed(1)}s · 🔢 ${k(input)} in (${k(m.cacheReadTokens)} cached) · ${k(m.outputTokens)} out · ${short}${m.turns > 1 ? ` · ${m.turns} steps` : ""}`;
}
