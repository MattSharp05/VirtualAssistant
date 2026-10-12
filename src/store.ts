import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOUR_MS = 60 * 60 * 1000;

/** A cloud session JARVIS started. JARVIS can't list your cloud sessions, so it remembers the ones it made. */
export interface Job {
  id: string; // short handle for Telegram, e.g. "j3"
  sessionId: string;
  url: string;
  task: string;
  createdAt: string;
  lastMessageAt?: string;
  messagesSent?: number;
}

/** A message a cloud session sent back (POST /api/reports). */
export interface Report {
  jobId: string;
  text: string;
  receivedAt: string;
}

const MAX_REPORTS = 200;

interface State {
  nextJob: number;
  currentJobId?: string;
  jobs: Job[];
  /** When each routine fire happened, to stay under the 30/hour-per-routine limit. */
  fires?: string[];
  reports?: Report[];
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

  addReport(jobId: string, text: string): Report {
    const report = { jobId: jobId.toLowerCase(), text, receivedAt: new Date().toISOString() };
    this.state.reports = [...(this.state.reports ?? []), report].slice(-MAX_REPORTS);
    this.save();
    return report;
  }

  /** Newest first. */
  recentReports(limit = 50): Report[] {
    return (this.state.reports ?? []).slice(-limit).reverse();
  }

  recentJobs(limit = 10): Job[] {
    return this.state.jobs.slice(-limit).reverse();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}
