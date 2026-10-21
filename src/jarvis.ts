// What JARVIS can do, independent of where the request came from (Telegram or the dashboard).

import { authStatus, renameCloudSession, sendToSession, type ApiDeps, type AuthStatus } from "./cloud.js";
import type { Config } from "./config.js";
import { NotionStatusCache, type NotionStatus } from "./notion.js";
import { followUpText, newJobText } from "./prompts.js";
import { fireRoutine } from "./routines.js";
import { JOB_NAME, parseSessionId, sessionUrl, type Job, type Store } from "./store.js";
import { SessionMetricsSource } from "./sessionMetrics.js";
import { SessionStarter, type StartPath } from "./sessionStart.js";
import { SessionListCache, type SessionList } from "./sessions.js";
import { UsageCache, type PlanUsage } from "./usage.js";

/** Documented per-routine cap on API fires (shared with "Run now"). Only routine-fallback jobs use one (JD-69). */
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
  /** Makes new sessions with the sessions API (JD-69); tests swap in one with fakes. */
  starter: SessionStarter;
  /** The sessions API's fetch and login folder (tests point them at fakes). */
  api: ApiDeps = {};

  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {
    this.usage = new UsageCache(config.claudeBin);
    this.sessionList = new SessionListCache(config.claudeBin);
    this.notion = new NotionStatusCache(config.notionToken);
    this.starter = new SessionStarter(config);
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

  /**
   * Starts a cloud session on a task (JD-69): a normal, titled and tagged session from the sessions
   * API; the JARVIS Worker routine only when that isn't available (and then under its hourly cap).
   */
  async startJob(task: string): Promise<{ job: Job; ms: number; via: StartPath; fireNumber?: number }> {
    task = task.trim();
    if (!task) throw new JarvisError("The task is empty.");

    const jobId = this.store.newJobId();
    const sentAt = new Date();
    let direct: Awaited<ReturnType<SessionStarter["start"]>> | undefined;
    let reason = "";
    try {
      direct = await this.starter.start(jobId, task, sentAt);
    } catch (err) {
      reason = (err as Error).message;
      console.warn(`sessions API couldn't start ${jobId} (${reason.slice(0, 200)}); trying the routine`);
    }
    if (direct) {
      const { sessionId, url, title, tags, via } = direct;
      const job: Job = { id: jobId, sessionId, url, task, createdAt: sentAt.toISOString(), kind: "started", via, title, tags };
      this.store.addJob(job);
      return { job, ms: Date.now() - sentAt.getTime(), via };
    }

    const { routineId, routineToken } = this.config;
    if (!routineId || !routineToken) {
      throw new JarvisError(`Couldn't start a session: ${reason.replace(/\.?$/, ".")} No routine configured as a fallback (ROUTINE_ID / ROUTINE_TOKEN).`);
    }
    const recent = this.store.firesInLastHour();
    if (recent.length >= FIRES_PER_HOUR) {
      const freeAt = new Date(recent[0].getTime() + 60 * 60 * 1000);
      throw new JarvisError(
        `The sessions API failed (${reason}) and the routine fallback is at ${FIRES_PER_HOUR} fires this hour. Next slot frees at ${freeAt.toISOString().slice(11, 16)} UTC. Messages to existing jobs still work.`,
      );
    }
    const session = await fireRoutine(routineId, routineToken, newJobText(jobId, task, sentAt), this.api.fetchImpl);
    this.store.recordFire(sentAt);
    // The routines-fire API has no title field (JD-81), so the session starts out called "Jarvis
    // Worker"; rename it to the real title right away instead of waiting for the one-off below. Only
    // keep the title once the rename actually lands, so a failed one still gets picked up there.
    let title: string | undefined;
    try {
      const computed = await this.starter.title(jobId, task);
      const renamed = await renameCloudSession(session.sessionId, computed, this.api);
      if (renamed.ok) title = computed;
      else console.warn(`couldn't rename ${jobId} (${session.sessionId}) to "${computed}": ${renamed.error}`);
    } catch (err) {
      console.warn(`couldn't title/rename ${jobId}: ${(err as Error).message}`);
    }
    console.log(`started ${jobId} via the routine: ${session.sessionId}${title ? ` "${title}"` : ""}`);
    const job: Job = { id: jobId, ...session, task, createdAt: sentAt.toISOString(), kind: "started", via: "routine", ...(title ? { title } : {}) };
    this.store.addJob(job);
    return { job, ms: Date.now() - sentAt.getTime(), via: "routine", fireNumber: recent.length + 1 };
  }

  /**
   * The one-off rename (JD-69, JD-81): gives any session JARVIS started through the routine that
   * still has no title (the rename above failed, or it predates it — all called "Jarvis Worker") a
   * title made from its task, where the API lets it. They stay routine runs, so the Claude Code
   * sidebar still won't list them.
   */
  async renameRoutineSessions(): Promise<{ renamed: Job[]; failed: { job: Job; error: string }[] }> {
    const todo = this.store.recentJobs(1000).filter((j) => j.kind === "started" && (j.via === undefined || j.via === "routine") && !j.title);
    const renamed: Job[] = [];
    const failed: { job: Job; error: string }[] = [];
    // Four at a time: each title is one short model call.
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(
        todo.slice(i, i + 4).map(async (job) => {
          const title = await this.starter.title(job.id, job.task);
          const result = await renameCloudSession(job.sessionId, title, this.api);
          if (result.ok) renamed.push(this.store.updateJob(job.id, { title }) ?? job);
          else failed.push({ job, error: result.error ?? "refused" });
        }),
      );
    }
    if (renamed.length) this.sessionList.get(true).catch(() => undefined);
    return { renamed, failed };
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
