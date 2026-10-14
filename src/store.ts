import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { BrainChannel, BrainMetrics } from "@jarvis/shared";
import { join } from "node:path";

const HOUR_MS = 60 * 60 * 1000;

/**
 * A cloud session JARVIS can message. JARVIS can't list your cloud sessions, so it knows the ones
 * it started, the ones you attach by link, and the ones that report in.
 */
export interface Job {
  id: string; // short handle: "j3" for ones JARVIS started, a name like "mk" for the rest
  sessionId: string;
  url: string;
  task: string;
  createdAt: string;
  lastMessageAt?: string;
  messagesSent?: number;
  /** started: JARVIS fired the routine. attached: you pasted its link. reported: it reported in first. */
  kind?: "started" | "attached" | "reported";
  /** Set when a report moved this name to a newer session (a successor orchestrator took over). */
  sessionUpdatedAt?: string;
}

/** Names you can give attached sessions: short, lowercase, and never shaped like JARVIS's own j-numbers. */
export const JOB_NAME = /^(?!j\d+$)[a-z][a-z0-9-]{0,23}$/;

/** Pulls a session ID out of a claude.ai link or a bare ID. */
export function parseSessionId(input: string): string | undefined {
  return input.match(/\b((?:session|cse)_[A-Za-z0-9]+)\b/)?.[1];
}

export function sessionUrl(sessionId: string): string {
  return `https://claude.ai/code/${sessionId}`;
}

/** A message a cloud session sent back (POST /api/reports). */
export interface Report {
  jobId: string;
  text: string;
  receivedAt: string;
}

const MAX_REPORTS = 200;
const MAX_BRAIN_MESSAGES = 300;

export type { BrainMetrics };

export interface BrainMessage {
  at: string;
  from: "you" | "jarvis";
  channel: BrainChannel;
  text: string;
  metrics?: BrainMetrics;
}

export interface BrainState {
  sessionId?: string;
  model?: string;
  messages: BrainMessage[];
  totals: { replies: number; inputTokens: number; outputTokens: number; ms: number; apiEquivalentUsd: number };
  /** Telegram: "jarvis" = plain messages go to the brain; a job id = straight to that session. */
  talkTo?: string;
}

interface State {
  nextJob: number;
  currentJobId?: string;
  jobs: Job[];
  /** When each routine fire happened, to stay under the 30/hour-per-routine limit. */
  fires?: string[];
  reports?: Report[];
  brain?: BrainState;
}

export class Store {
  private readonly file: string;
  private state: State;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "state.json");
    try {
      this.state = JSON.parse(readFileSync(this.file, "utf8")) as State;
    } catch {
      this.state = { nextJob: 1, jobs: [] };
    }
  }

  newJobId(): string {
    const id = `j${this.state.nextJob++}`;
    this.save();
    return id;
  }

  addJob(job: Job): void {
    this.state.jobs.push(job);
    this.state.currentJobId = job.id;
    this.save();
  }

  getJob(id: string): Job | undefined {
    return this.state.jobs.find((j) => j.id === id.toLowerCase());
  }

  findBySession(sessionId: string): Job | undefined {
    return this.state.jobs.find((j) => j.sessionId === sessionId);
  }

  currentJob(): Job | undefined {
    return this.state.currentJobId ? this.getJob(this.state.currentJobId) : undefined;
  }

  setCurrent(id: string): Job | undefined {
    const job = this.getJob(id);
    if (job) {
      this.state.currentJobId = job.id;
      this.save();
    }
    return job;
  }

  touch(id: string): void {
    const job = this.getJob(id);
    if (job) {
      job.lastMessageAt = new Date().toISOString();
      job.messagesSent = (job.messagesSent ?? 0) + 1;
      this.save();
    }
  }

  recordFire(now = new Date()): void {
    this.state.fires = [...this.firesSince(now.getTime() - HOUR_MS), now.toISOString()];
    this.save();
  }

  /** Fires in the last hour, oldest first. */
  firesInLastHour(now = new Date()): Date[] {
    return this.firesSince(now.getTime() - HOUR_MS).map((t) => new Date(t));
  }

  private firesSince(cutoffMs: number): string[] {
    return (this.state.fires ?? []).filter((t) => Date.parse(t) > cutoffMs);
  }

  /**
   * Stores a report. When it says which session sent it, JARVIS follows that session: an unknown
   * name becomes a new "reported" job, and a known one moves to the newer session, so messages
   * reach whichever orchestrator is current.
   */
  addReport(jobId: string, text: string, sessionId?: string): Report {
    const id = jobId.toLowerCase();
    const now = new Date().toISOString();
    if (sessionId) {
      const job = this.getJob(id);
      if (!job) {
        this.state.jobs.push({ id, sessionId, url: sessionUrl(sessionId), task: "Reported in on its own", createdAt: now, kind: "reported" });
      } else if (job.sessionId !== sessionId) {
        job.sessionId = sessionId;
        job.url = sessionUrl(sessionId);
        job.sessionUpdatedAt = now;
      }
    }
    const report = { jobId: id, text, receivedAt: now };
    this.state.reports = [...(this.state.reports ?? []), report].slice(-MAX_REPORTS);
    this.save();
    return report;
  }

  /** Forgets a job (not its reports). The cloud session itself is untouched. */
  removeJob(id: string): boolean {
    const before = this.state.jobs.length;
    this.state.jobs = this.state.jobs.filter((j) => j.id !== id.toLowerCase());
    if (this.state.currentJobId === id.toLowerCase()) this.state.currentJobId = undefined;
    this.save();
    return this.state.jobs.length < before;
  }

  /** Newest first. */
  recentReports(limit = 50): Report[] {
    return (this.state.reports ?? []).slice(-limit).reverse();
  }

  /** Most recently active first. */
  recentJobs(limit = 10): Job[] {
    const lastReport = new Map<string, string>();
    for (const r of this.state.reports ?? []) lastReport.set(r.jobId, r.receivedAt);
    const active = (j: Job) =>
      [j.createdAt, j.lastMessageAt, j.sessionUpdatedAt, lastReport.get(j.id)].filter(Boolean).sort().pop() ?? "";
    return [...this.state.jobs].sort((a, b) => active(b).localeCompare(active(a))).slice(0, limit);
  }

  brain(): BrainState {
    this.state.brain ??= { messages: [], totals: { replies: 0, inputTokens: 0, outputTokens: 0, ms: 0, apiEquivalentUsd: 0 } };
    return this.state.brain;
  }

  updateBrain(patch: Partial<Omit<BrainState, "messages" | "totals">>): void {
    Object.assign(this.brain(), patch);
    this.save();
  }

  addBrainMessage(message: BrainMessage): void {
    const brain = this.brain();
    brain.messages = [...brain.messages, message].slice(-MAX_BRAIN_MESSAGES);
    const m = message.metrics;
    if (m) {
      brain.totals.replies++;
      brain.totals.inputTokens += m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
      brain.totals.outputTokens += m.outputTokens;
      brain.totals.ms += m.ms;
      brain.totals.apiEquivalentUsd += m.apiEquivalentUsd ?? 0;
    }
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}
