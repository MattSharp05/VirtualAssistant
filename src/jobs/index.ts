// Background jobs for the worker brain (ADR 0007). Every other file in this folder default-exports
// a JobDef and is discovered at startup; each defines its own submit_* tool (registered by
// src/tools/submit.ts), so a new job never edits shared files.
//
// The runner does one job at a time: a fresh worker conversation with the job's prompt, which must
// call the submit tool once (120 s limit). The tool's input is validated; a failure keeps the last
// good result. Scheduled jobs run inside their hours, and pause when the plan's 5-hour window is
// ≥ 90% used.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DeskEvent } from "@jarvis/shared";
import type { EventBus } from "../events.js";
import { JarvisError } from "../jarvis.js";
import { JsonFile } from "../storage.js";
import type { JsonSchema, ToolContext } from "../tools/types.js";
import type { PlanUsage } from "../usage.js";

export interface JobDef<T = unknown, R = T> {
  name: string;
  /** The structured-output tool the worker must call exactly once. */
  submitTool: { name: string; description: string; inputSchema: JsonSchema };
  /** The worker's instructions for one run. */
  prompt(now: Date, ctx: ToolContext): string;
  /** Checks the submitted input; throws with a reason the worker can read. */
  validate(input: unknown): T;
  /** Adds what the server knows itself (tasks, reports…) to the worker's result. */
  finish?(data: T, ctx: ToolContext, now: Date): Promise<R>;
  /** Runs every `minutes` between `fromHour` and `toHour` (local time, TZ). */
  schedule?: { minutes: number; fromHour: number; toHour: number };
  /** Published after a successful run. */
  event?(result: R): DeskEvent;
}

export interface JobResult<R = unknown> {
  at: string;
  data: R;
}

export interface Worker {
  chat(text: string, channel: "worker"): Promise<unknown>;
  reset(): void;
}

const TIMEOUT_MS = 120_000;
/** Background jobs pause above this share of the plan's 5-hour window. */
export const PAUSE_AT_USAGE = 90;

export async function discoverJobs(dir = dirname(fileURLToPath(import.meta.url))): Promise<JobDef[]> {
  const jobs: JobDef[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "index.js").sort()) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: JobDef };
    if (mod.default?.name && mod.default.submitTool) jobs.push(mod.default);
  }
  return jobs;
}

interface JobsFile {
  results: Record<string, JobResult>;
  lastRun: Record<string, string>;
  lastError: Record<string, string>;
}

export class JobRunner {
  private readonly file: JsonFile<JobsFile>;
  private readonly jobs = new Map<string, JobDef>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly running = new Set<string>();
  private pending?: { job: string; resolve(data: unknown): void };

  constructor(
    jobs: JobDef[],
    private readonly worker: Worker,
    private readonly ctx: ToolContext,
    private readonly opts: { dataDir: string; bus?: EventBus; usage?: () => Promise<PlanUsage | undefined>; now?: () => Date; timeoutMs?: number },
  ) {
    for (const j of jobs) this.jobs.set(j.name, j);
    this.file = new JsonFile<JobsFile>(opts.dataDir, "jobs", { results: {}, lastRun: {}, lastError: {} });
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  get submitToolNames(): string[] {
    return [...this.jobs.values()].map((j) => j.submitTool.name);
  }

  result<R>(name: string): JobResult<R> | undefined {
    return this.file.get().results[name] as JobResult<R> | undefined;
  }

  lastError(name: string): string | undefined {
    return this.file.get().lastError[name];
  }

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  /** Called by the job's submit tool (via the MCP server): validates and hands the data to the run. */
  submit(name: string, input: unknown): string {
    const job = this.jobs.get(name);
    if (!job) throw new JarvisError(`No job ${name}.`);
    if (!this.pending || this.pending.job !== name) throw new JarvisError(`${job.submitTool.name} is only for the ${name} job while it runs.`);
    const data = job.validate(input); // throws: the worker reads why and can fix it
    this.pending.resolve(data);
    this.pending = undefined;
    return "Received. You're done: no more tool calls.";
  }

  /** Runs a job now (queued behind any running one). Keeps the last good result on failure. */
  run(name: string): Promise<JobResult | undefined> {
    const job = this.jobs.get(name);
    if (!job) return Promise.reject(new JarvisError(`No job ${name}.`));
    const run = this.queue.then(() => this.runOne(job));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runOne(job: JobDef): Promise<JobResult | undefined> {
    this.running.add(job.name);
    const started = this.now();
    void this.file.update((f) => ({ ...f, lastRun: { ...f.lastRun, [job.name]: started.toISOString() } }));
    let timer: NodeJS.Timeout | undefined;
    try {
      const submitted = new Promise<unknown>((resolve) => (this.pending = { job: job.name, resolve }));
      this.worker.reset(); // a fresh conversation every run
      const turn = this.worker.chat(job.prompt(started, this.ctx), "worker");
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${job.name} took longer than ${(this.opts.timeoutMs ?? TIMEOUT_MS) / 1000}s`)), this.opts.timeoutMs ?? TIMEOUT_MS);
      });
      // Done when the data arrives; if the worker's turn ends first without it, that's a failure.
      const data = await Promise.race([
        submitted,
        turn.then(async () => {
          await new Promise((r) => setTimeout(r, 50)); // a submit racing the turn's end still counts
          if (this.pending?.job === job.name) throw new Error(`the worker finished without calling ${job.submitTool.name}`);
          return submitted;
        }),
        timeout,
      ]);
      const finished = job.finish ? await job.finish(data, this.ctx, started) : data;
      const result: JobResult = { at: this.now().toISOString(), data: finished };
      await this.file.update((f) => ({ ...f, results: { ...f.results, [job.name]: result }, lastError: { ...f.lastError, [job.name]: "" } }));
      const event = job.event?.(finished);
      if (event) this.opts.bus?.publish(event);
      return result;
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`job ${job.name} failed (keeping the last result): ${message}`);
      await this.file.update((f) => ({ ...f, lastError: { ...f.lastError, [job.name]: message } }));
      return this.result(job.name);
    } finally {
      clearTimeout(timer);
      this.pending = undefined;
      this.running.delete(job.name);
    }
  }

  /** Is a scheduled job due now: inside its hours and at least `minutes` since its last run? */
  due(job: JobDef, now = this.now()): boolean {
    if (!job.schedule) return false;
    const hour = now.getHours() + now.getMinutes() / 60;
    if (hour < job.schedule.fromHour || hour >= job.schedule.toHour) return false;
    const last = this.file.get().lastRun[job.name];
    return !last || now.getTime() - Date.parse(last) >= job.schedule.minutes * 60_000 - 5_000;
  }

  /** Called every minute: runs what's due, unless the plan is nearly used up. Returns what it started. */
  async tick(): Promise<string[]> {
    const due = [...this.jobs.values()].filter((j) => !this.running.has(j.name) && this.due(j));
    if (!due.length) return [];
    const usage = await this.opts.usage?.().catch(() => undefined);
    const fiveHour = usage?.available ? usage.windows.find((w) => w.name === "five_hour") : undefined;
    if (fiveHour && fiveHour.percent >= PAUSE_AT_USAGE) return [];
    for (const j of due) void this.run(j.name);
    return due.map((j) => j.name);
  }
}

/** The process's runner, registered by index.ts (keyed by the JARVIS instance, so tests get their own). */
const runners = new WeakMap<object, JobRunner>();

export function useJobRunner(owner: object, runner: JobRunner): void {
  runners.set(owner, runner);
}

export function jobRunnerFor(owner: object): JobRunner {
  const r = runners.get(owner);
  if (!r) throw new JarvisError("Background jobs aren't running.");
  return r;
}
