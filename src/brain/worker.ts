// The worker brain (ADR 0007): a second Claude conversation for background jobs (Today digest,
// suggestions…), so they never clutter Matthew's chat. Same Brain class, but:
//   - its own folder, conversation and usage totals (DATA_DIR/worker.json), and no Desk events;
//   - a strict prompt: no chit-chat, gather with read-only tools, call the job's submit tool once;
//   - only read tools: claude.ai connectors read-only (calendar writes are blocked here) and a short
//     list of JARVIS read tools plus the jobs' submit_* tools.
//   - one process per job (a fresh conversation each run), WORKER_MODEL (default haiku).

import type { BrainMessage, BrainState } from "../store.js";
import { JsonFile } from "../storage.js";
import { CALENDAR_WRITES, connectorTools } from "../tools/connectors.js";
import type { BrainSetup, ToolContext } from "../tools/index.js";
import { Brain, type BrainConfig, type BrainStateStore } from "./index.js";

export const WORKER_PROMPT = `You are JARVIS's background worker. You are not talking to anyone: you gather information with read-only tools and hand the result back by calling the job's submit tool exactly once, with JSON that matches its schema. No greetings, no commentary, no questions. If a source is unavailable or a tool fails, submit what you have (empty lists are fine) rather than stopping. Never change anything: you have no tools that write.`;

/** JARVIS tools the worker may read with (plus every job's submit tool). */
export const WORKER_READ_TOOLS = ["overview", "list_cloud_sessions", "session_activity", "notion_search", "notion_read_page", "notion_query_database", "list_tasks", "recall"];

/** The worker's usage and conversation, kept apart from the chat's (System window). */
export class WorkerState implements BrainStateStore {
  private readonly file: JsonFile<{ state: BrainState }>;

  /** `name`: the file under DATA_DIR (browser tasks keep their own, JD-60). */
  constructor(dataDir: string, name = "worker") {
    this.file = new JsonFile(dataDir, name, {
      state: { messages: [], totals: { replies: 0, inputTokens: 0, outputTokens: 0, ms: 0, apiEquivalentUsd: 0 } } as BrainState,
    });
  }

  brain(): BrainState {
    return this.file.get().state;
  }

  updateBrain(patch: Partial<Omit<BrainState, "messages" | "totals">>): void {
    void this.file.update((f) => ({ state: { ...f.state, ...patch } }));
  }

  addBrainMessage(message: BrainMessage): void {
    void this.file.update((f) => {
      const state = { ...f.state, messages: [...f.state.messages, message].slice(-40), totals: { ...f.state.totals } };
      const m = message.metrics;
      if (m) {
        state.totals.replies++;
        state.totals.inputTokens += m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
        state.totals.outputTokens += m.outputTokens;
        state.totals.ms += m.ms;
        state.totals.apiEquivalentUsd += m.apiEquivalentUsd ?? 0;
      }
      return { state };
    });
  }
}

/** Read-only connectors + the JARVIS read tools + the submit tools; nothing that writes. */
export function workerSetup(ctx: ToolContext, submitTools: string[]): BrainSetup {
  const { allowed, blocked } = connectorTools(ctx.config.brainConnectors ?? []);
  return {
    hints: [],
    parts: [],
    allowedTools: allowed.filter((t) => !CALENDAR_WRITES.includes(t)),
    disallowedTools: [...blocked, ...CALENDAR_WRITES],
    extraArgs: [],
    jarvisTools: [...WORKER_READ_TOOLS, ...submitTools],
  };
}

export interface WorkerOptions extends Omit<BrainConfig, "setup" | "prompt" | "name" | "bus" | "warm"> {
  /** The model for background jobs (WORKER_MODEL; default haiku if it's offered). */
  model?: string;
}

export function createWorker(opts: WorkerOptions, ctx: ToolContext, submitTools: () => string[]): Brain {
  const model = opts.model ?? (opts.models.find((m) => m.includes("haiku")) ?? opts.defaultModel);
  const models = opts.models.includes(model) ? opts.models : [...opts.models, model];
  return new Brain(
    {
      ...opts,
      models,
      defaultModel: model,
      name: "worker",
      warm: false,
      prompt: () => WORKER_PROMPT,
      setup: async () => workerSetup(ctx, submitTools()),
    },
    new WorkerState(opts.dataDir),
  );
}
