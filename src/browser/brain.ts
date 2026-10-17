// The browser task's brain (JD-60): a worker brain (ADR 0007: same Brain class, the worker's model,
// one process per turn, its own folder, conversation and usage file) with the browser task prompt and
// only the browser brain's tools: the browser_* step tools, browser_ask and browser_done, plus Read
// inside the uploads folder for browser_screenshot. No claude.ai connectors, nothing else of JARVIS's.
import { Brain } from "../brain/index.js";
import { WorkerState, type WorkerOptions } from "../brain/worker.js";
import { BROWSER_TASK_PROMPT } from "../prompts.js";
import type { BrainSetup } from "../tools/index.js";
import { BROWSER_TASK_TOOLS } from "../tools/browser.js";
import { uploadsDir } from "../uploads.js";

/** One turn may run many steps (and Matthew may take a while to type a password in the middle). */
export const BROWSER_TURN_MS = 15 * 60_000;

export function browserSetup(dataDir: string): BrainSetup {
  const dir = uploadsDir(dataDir);
  return {
    hints: [],
    parts: [],
    allowedTools: [],
    disallowedTools: [],
    extraArgs: ["--add-dir", dir],
    builtinTools: ["Read"],
    allowRules: [`Read(/${dir}/**)`],
    jarvisTools: BROWSER_TASK_TOOLS,
  };
}

export function createBrowserBrain(opts: WorkerOptions): Brain {
  const model = opts.model ?? (opts.models.find((m) => m.includes("haiku")) ?? opts.defaultModel);
  const models = opts.models.includes(model) ? opts.models : [...opts.models, model];
  return new Brain(
    {
      ...opts,
      models,
      defaultModel: model,
      name: "browser",
      warm: false,
      timeoutMs: BROWSER_TURN_MS,
      prompt: () => BROWSER_TASK_PROMPT,
      setup: async () => browserSetup(opts.dataDir),
    },
    new WorkerState(opts.dataDir, "browser-worker"),
  );
}
