// What JARVIS can do, independent of where the request came from (Telegram or the dashboard).

import { authStatus, sendToSession, type AuthStatus } from "./cloud.js";
import type { Config } from "./config.js";
import { NotionStatusCache, type NotionStatus } from "./notion.js";
import { followUpText, newJobText } from "./prompts.js";
import { fireRoutine } from "./routines.js";
import { JOB_NAME, parseSessionId, sessionUrl, type Job, type Store } from "./store.js";
import { SessionMetricsSource } from "./sessionMetrics.js";
import { SessionListCache, type SessionList } from "./sessions.js";
import { UsageCache, type PlanUsage } from "./usage.js";

/** Documented per-routine cap on API fires (shared with "Run now"). Each new job is one fire. */
export const FIRES_PER_HOUR = 30;

export class JarvisError extends Error {}

export interface Status {
  auth: AuthStatus;
  usage: PlanUsage;
  routineConfigured: boolean;
  routineId?: string;
  firesThisHour: number;
  firesPerHour: number;
  /** When the oldest fire in the window drops out, freeing a slot. */
  nextFireFreesAt?: string;
  telegram: boolean;
  reportsEndpoint: boolean;
  notion: NotionStatus;
}

export class Jarvis {
  private readonly usage: UsageCache;
  private readonly sessionList: SessionListCache;
  private readonly notion: NotionStatusCache;
  /** Per-session tokens, cost, context and activity (JD-53); tests swap in one with a fake fetch. */
  metrics = new SessionMetricsSource();
  private auth?: { value: AuthStatus; at: number };

  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {
    this.usage = new UsageCache(config.claudeBin);
    this.sessionList = new SessionListCache(config.claudeBin);
    this.notion = new NotionStatusCache(config.notionToken);
  }

  /** Your cloud sessions, newest activity first (undocumented source; see sessions.ts). */
  listSessions(force = false): Promise<SessionList> {
    return this.sessionList.get(force);
  }

  /**
   * Picks a session from the list to talk to: reuses the job already tracking it, or attaches it
   * under a name made from its title (e.g. "Mario Kart orchestrator" → "mario-kart-orchestrator").
   */
  pickSession(sessionId: string, title = ""): Job {
    const existing = this.store.findBySession(sessionId);
    if (existing) {
      this.store.setCurrent(existing.id);
      return existing;
    }
    const base = slugName(title) ?? "session";
    let name = base;
    // Names max out at 24 characters, so trim only as much as the "-n" suffix needs.
    for (let n = 2; this.store.getJob(name); n++) name = `${base.slice(0, 23 - String(n).length).replace(/-+$/, "")}-${n}`;
    const job = this.attachSession(sessionId, name, title || "Picked from your session list");
    return job;
  }

  async startJob(task: string): Promise<{ job: Job; ms: number; fireNumber: number }> {
    task = task.trim();
    if (!task) throw new JarvisError("The task is empty.");
    const { routineId, routineToken } = this.config;
    if (!routineId || !routineToken) throw new JarvisError("No routine configured. Set ROUTINE_ID and ROUTINE_TOKEN (see README).");

    const recent = this.store.firesInLastHour();
    if (recent.length >= FIRES_PER_HOUR) {
      const freeAt = new Date(recent[0].getTime() + 60 * 60 * 1000);
      throw new JarvisError(
        `That would be fire ${recent.length + 1} this hour; the routine allows ${FIRES_PER_HOUR}. Next slot frees at ${freeAt.toISOString().slice(11, 16)} UTC. Messages to existing jobs still work.`,
      );
    }

    const jobId = this.store.newJobId();
    const sentAt = new Date();
    const session = await fireRoutine(routineId, routineToken, newJobText(jobId, task, sentAt));
    this.store.recordFire(sentAt);
    const job: Job = { id: jobId, ...session, task, createdAt: sentAt.toISOString(), kind: "started" };
    this.store.addJob(job);
    return { job, ms: Date.now() - sentAt.getTime(), fireNumber: recent.length + 1 };
  }

  /** Adds a session JARVIS didn't start (an orchestrator, say) so you can message it by name. */
  attachSession(link: string, name: string, note?: string): Job {
    const sessionId = parseSessionId(link);
    if (!sessionId) throw new JarvisError("That isn't a session link. Paste the claude.ai/code/… address of the session.");
    const id = name.trim().toLowerCase();
    if (!JOB_NAME.test(id)) {
      throw new JarvisError("Names are 1-24 lowercase letters, digits or dashes, starting with a letter (e.g. mk or mario-kart).");
    }
    if (this.store.getJob(id)) throw new JarvisError(`There's already a job called ${id}. Forget it first, or pick another name.`);
    const job: Job = {
      id,
      sessionId,
      url: sessionUrl(sessionId),
      task: note?.trim() || "Attached session",
      createdAt: new Date().toISOString(),
      kind: "attached",
    };
    this.store.addJob(job);
    return job;
  }

  forget(jobId: string): void {
    if (!this.store.removeJob(jobId)) throw new JarvisError(`No job ${jobId}.`);
  }

  async sendMessage(jobId: string, message: string): Promise<{ job: Job; ms: number }> {
    const job = this.store.getJob(jobId);
    if (!job) throw new JarvisError(`No job ${jobId}.`);
    if (!message.trim()) throw new JarvisError("The message is empty.");
    const sentAt = new Date();
    const result = await sendToSession(this.config.claudeBin, job.sessionId, followUpText(job.id, message, sentAt, job.kind !== "started" && job.kind !== undefined));
    if (!result.ok) throw new JarvisError(`Couldn't reach ${job.id}: ${result.error ?? "unknown error"}`);
    this.store.touch(job.id);
    return { job, ms: Date.now() - sentAt.getTime() };
  }

  /** The plan's 5-hour and weekly usage (cached for a minute; the Desk's tray polls it). */
  planUsage(): Promise<PlanUsage> {
    return this.usage.get();
  }

  /** Cached for 30s: the dashboard polls, and each check spawns the CLI (~1-2s). */
  private async authStatus(): Promise<AuthStatus> {
    if (!this.auth || Date.now() - this.auth.at > 30_000) {
      this.auth = { value: await authStatus(this.config.claudeBin), at: Date.now() };
    }
    return this.auth.value;
  }

  async status(): Promise<Status> {
    const [auth, usage, notion] = await Promise.all([this.authStatus(), this.usage.get(), this.notion.get()]);
    const fires = this.store.firesInLastHour();
    return {
      auth,
      usage,
      routineConfigured: Boolean(this.config.routineId && this.config.routineToken),
      routineId: this.config.routineId,
      firesThisHour: fires.length,
      firesPerHour: FIRES_PER_HOUR,
      nextFireFreesAt: fires[0] ? new Date(fires[0].getTime() + 60 * 60 * 1000).toISOString() : undefined,
      telegram: Boolean(this.config.telegramBotToken),
      reportsEndpoint: Boolean(this.config.reportSecret),
      notion,
    };
  }
}

/** A job name from a session title: lowercase words joined by dashes, at most 24 characters. */
export function slugName(title: string): string | undefined {
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  if (!slug) return undefined;
  if (!/^[a-z]/.test(slug)) slug = `s-${slug}`.slice(0, 24);
  return JOB_NAME.test(slug) ? slug : undefined;
}
