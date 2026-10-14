// The conversational brain: Matthew talks in plain language, Claude decides what to do with
// JARVIS's tools (mcp.ts). Runs on the Claude subscription through the CLI in the container:
//   claude -p --model <m> --system-prompt <JARVIS> --tools "" --strict-mcp-config --mcp-config <jarvis>
// --tools "" removes every built-in tool (no shell, no files); the tools are JARVIS's own, plus the
// read-only tools of the claude.ai connectors in BRAIN_CONNECTORS (Google Calendar, Gmail). Their
// write tools are blocked outright, and in -p mode anything not allowed is refused anyway.
// One conversation at a time, resumed across messages; "new conversation" starts a fresh one.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainMessage, BrainMetrics, Store } from "./store.js";

const TIMEOUT_MS = 240_000;

export const SYSTEM_PROMPT = `You are JARVIS, Matthew's personal assistant. You run in his JARVIS container and he talks to you from Telegram or his dashboard, usually on his phone.

What you manage: Matthew builds software with Claude Code cloud sessions. Each project has an orchestrator session (named by ticket prefix, e.g. "mk" for Mario Kart) that runs builder sessions and reports progress; tickets, PRDs and docs live in Notion.

How to work:
- Use your tools; never guess a session's state. "What's X doing / how's X going" → overview, then session_activity for that session.
- When Matthew asks you to tell a session something, send it with send_to_session (clear, self-contained, in his voice), then confirm in one line what you sent. Its answer arrives later as a report.
- You may start new cloud sessions with start_session when he asks for work to be done.
- Notion is read-only for you: search, read pages, list database rows.
- If you have Google Calendar and Gmail tools, they are read-only. "What's on today/this week" → list_events for that range. Email → search_threads with Gmail search syntax (e.g. "is:unread newer_than:1d", "from:alex"), then get_thread for the ones that matter. Summarise; don't paste whole emails. Give event times in the calendar's own time zone.
- If you have Slack tools, they are read-only too. "What did I miss / anything on Slack" → slack_search_public_and_private (e.g. "to:me after:yesterday", "in:#channel") or slack_read_channel, then slack_read_thread for threads that matter. Say who said what, briefly.
- If a tool fails, say what failed in one line and what he can do.

How to answer: short and plain, for a phone screen. Lead with the answer. No headings, minimal lists, no filler. Times in his messages are UTC.`;

/**
 * claude.ai connectors the brain can use, by the name claude.ai shows: the tools it may call (all
 * read-only) and the write tools that stay blocked. In the CLI, "Google Calendar" becomes the
 * server claude_ai_Google_Calendar.
 */
export const CONNECTORS: Record<string, { read: string[]; blocked: string[] }> = {
  "Google Calendar": {
    read: ["list_calendars", "list_events", "get_event", "search_events", "suggest_time"],
    blocked: ["create_event", "update_event", "delete_event", "respond_to_event"],
  },
  Gmail: {
    read: ["search_threads", "get_thread", "get_message", "list_labels", "list_drafts", "get_draft"],
    blocked: [
      "send_message", "reply", "forward", "create_draft", "update_draft", "delete_draft",
      "trash_message", "trash_thread", "untrash_message", "untrash_thread",
      "mark_message_spam", "mark_thread_spam", "unmark_message_spam", "unmark_thread_spam",
      "label_message", "label_thread", "unlabel_message", "unlabel_thread", "update_message_labels",
      "apply_sensitive_message_label", "apply_sensitive_thread_label",
      "create_label", "update_label", "delete_label",
    ],
  },
  Slack: {
    read: [
      "slack_search_public", "slack_search_public_and_private", "slack_search_channels", "slack_search_users",
      "slack_read_channel", "slack_read_thread", "slack_read_canvas", "slack_read_list", "slack_read_file",
      "slack_read_user_profile", "slack_list_user_channels", "slack_list_channel_members", "slack_get_reactions",
    ],
    blocked: [
      "slack_send_message", "slack_send_message_draft", "slack_schedule_message", "slack_add_reaction",
      "slack_create_conversation", "slack_create_canvas", "slack_update_canvas", "slack_create_list",
      "slack_update_list", "slack_add_list_record", "slack_update_list_record",
      "slack_get_file_upload_url", "slack_complete_file_upload",
    ],
  },
};

const serverName = (connector: string) => `mcp__claude_ai_${connector.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** --allowedTools / --disallowedTools entries for the chosen connectors (unknown names are skipped). */
export function connectorTools(names: string[]): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const name of names) {
    const key = Object.keys(CONNECTORS).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) continue;
    allowed.push(...CONNECTORS[key].read.map((t) => `${serverName(key)}__${t}`));
    blocked.push(...CONNECTORS[key].blocked.map((t) => `${serverName(key)}__${t}`));
  }
  return { allowed, blocked };
}

export interface BrainConfig {
  claudeBin: string;
  dataDir: string;
  models: string[];
  defaultModel: string;
  internalUrl: string;
  internalToken: string;
  /** claude.ai connectors to allow read access to (CONNECTORS keys). */
  connectors?: string[];
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

  private invoke(prompt: string, sessionId: string, fresh: boolean): Promise<{ result?: CliResult; stderr: string }> {
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
    const connectors = connectorTools(this.config.connectors ?? []);
    const args = [
      "-p",
      "--output-format", "json",
      "--model", this.model,
      "--system-prompt", SYSTEM_PROMPT,
      "--tools", "",
      // --strict-mcp-config also hides the claude.ai connectors, so it's only used when none are wanted.
      ...(connectors.allowed.length ? [] : ["--strict-mcp-config"]),
      "--mcp-config", mcpConfig,
      "--allowedTools", ["mcp__jarvis", ...connectors.allowed].join(","),
      ...(connectors.blocked.length ? ["--disallowedTools", connectors.blocked.join(",")] : []),
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
