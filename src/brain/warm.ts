// One long-lived `claude -p` process for the chat conversation (ADR 0003): the CLI and its MCP
// servers start once, so a reply's first words arrive in ~1–2 s instead of after a fresh spawn.
//
// The stream-json protocol, checked against Claude Code 2.1.x (`claude --help` and a local run):
//   spawn:  claude -p --input-format stream-json --output-format stream-json --verbose
//                     --include-partial-messages <today's flags> (--session-id <new> | --resume <id>)
//   stdin:  one JSON line per user turn: {"type":"user","message":{"role":"user","content":"<text>"}}
//   stdout: one JSON object per line; the process stays alive between turns. Per turn:
//     {"type":"system","subtype":"init",…}                                   (each turn)
//     {"type":"stream_event","event":{"type":"message_start"…}}              (each model step)
//     {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
//     {"type":"assistant","message":{"content":[{"type":"tool_use","id","name","input"}|{"type":"text"}…]}}
//     {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","content","is_error"}]}}
//     {"type":"result","result":"<final text>","is_error",duration_ms,num_turns,total_cost_usd,usage,…}
//   Other lines (rate_limit_event, system status, post_turn_summary…) are ignored.
//   Events from subagents carry a non-null parent_tool_use_id and are skipped.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { CliResult } from "./index.js";

export interface TurnHandlers {
  onDelta(text: string): void;
  onToolCall(id: string, name: string, input: unknown): void;
  onToolResult(id: string, summary: string, isError: boolean, text: string): void;
}

interface PendingTurn {
  handlers: TurnHandlers;
  resolve(result: CliResult): void;
  reject(err: Error): void;
  /** Text already streamed this turn, to put a paragraph break between model steps. */
  wrote: boolean;
  newStep: boolean;
}

/** Raised when the process exits (or can't start) before the turn finished. */
export class WarmExitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class WarmProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private turn?: PendingTurn;
  private stderr = "";
  private exited = false;
  lastUsed = Date.now();

  constructor(
    bin: string,
    args: string[],
    cwd: string,
    /** What it was started with, so the brain knows when it needs a new one. */
    readonly model: string,
    readonly sessionId: string,
  ) {
    this.child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.child.stdin.on("error", () => {});
    this.child.on("error", (err) => this.finish(err.message));
    this.child.on("close", (code) => this.finish(`the brain process exited (code ${code})`));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.line(line));
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Sends one user turn; resolves with the turn's result event. One turn at a time (the brain queues). */
  send(text: string, handlers: TurnHandlers): Promise<CliResult> {
    if (this.exited) return Promise.reject(new WarmExitError("the brain process isn't running", this.stderr));
    if (this.turn) return Promise.reject(new Error("a turn is already running"));
    this.lastUsed = Date.now();
    return new Promise<CliResult>((resolve, reject) => {
      this.turn = { handlers, resolve, reject, wrote: false, newStep: false };
      this.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    });
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.child.kill("SIGTERM");
    this.turn?.reject(new WarmExitError("the brain process was stopped", this.stderr));
    this.turn = undefined;
  }

  private finish(reason: string): void {
    this.exited = true;
    const turn = this.turn;
    this.turn = undefined;
    turn?.reject(new WarmExitError(reason, this.stderr));
  }

  private line(line: string): void {
    const turn = this.turn;
    if (!turn || !line.trim()) return;
    let msg: StreamLine;
    try {
      msg = JSON.parse(line) as StreamLine;
    } catch {
      return; // stray non-JSON output
    }
    if (msg.parent_tool_use_id) return;
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "message_start") turn.newStep = true;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        if (turn.newStep && turn.wrote) turn.handlers.onDelta("\n\n");
        turn.newStep = false;
        turn.wrote = true;
        turn.handlers.onDelta(ev.delta.text);
      }
    } else if (msg.type === "assistant") {
      for (const block of blocks(msg)) {
        if (block.type === "tool_use" && block.id && block.name) turn.handlers.onToolCall(block.id, block.name, block.input);
      }
    } else if (msg.type === "user") {
      for (const block of blocks(msg)) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const text = resultText(block.content);
          turn.handlers.onToolResult(block.tool_use_id, summarize(text), block.is_error === true, text.slice(0, 20_000));
        }
      }
    } else if (msg.type === "result") {
      this.turn = undefined;
      this.lastUsed = Date.now();
      turn.resolve(msg as CliResult);
    }
  }
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamLine {
  type?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: ContentBlock[] | string };
}

function blocks(msg: StreamLine): ContentBlock[] {
  const content = msg.message?.content;
  return Array.isArray(content) ? content : [];
}

/** A tool result's text (string content, or the text parts of a content array). */
function resultText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n")
      : "";
}

/** The first line of a tool result, short enough for a log line or a Desk chip. */
function summarize(text: string): string {
  const first = text.trim().split("\n")[0] ?? "";
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}
