// The morning brief (PRD: morning brief; mockup 5): a short spoken summary of Matthew's day, from the
// Today digest (refreshed first if it's over 30 min old), session reports since 18:00 yesterday and the
// number of suggested to-dos. The chat brain writes it from an instruction-prefixed prompt, so it lands
// in the normal conversation; `brief.ready` carries the text (the Mac speaks it once JD-38 lands).
//
// Triggers: POST /api/desk/brief, Telegram /brief, and the first Desk voice turn of the day between
// 05:00 and 12:00 (the brief goes first, then that request is answered). One brief a day is tracked in
// data/brief.json; any brief, however it was asked for, counts as that day's.

import { randomUUID } from "node:crypto";
import type { BrainChannel, Digest } from "@jarvis/shared";
import type { BrainReply, ChatOptions } from "./brain/index.js";
import type { EventBus } from "./events.js";
import type { JobRunner } from "./jobs/index.js";
import { JarvisError } from "./jarvis.js";
import type { Report } from "./store.js";
import { JsonFile } from "./storage.js";
import { tasks } from "./tools/tasks.js";
import type { ToolContext } from "./tools/types.js";

/** Refresh the digest before the brief when it's older than this. */
export const DIGEST_MAX_AGE_MS = 30 * 60_000;
/** How long the brief waits for that refresh before using what it has. */
const REFRESH_WAIT_MS = 60_000;
/** The automatic brief's window (local hours, Matthew's time zone). */
export const AUTO_FROM_HOUR = 5;
export const AUTO_TO_HOUR = 12;
/** "Overnight" starts at this local hour the day before. */
const OVERNIGHT_FROM_HOUR = 18;
const MAX_REPORTS = 12;

/** What the brief is built from. */
export interface BriefInput {
  now: Date;
  timeZone: string;
  digest?: Digest;
  /** The digest is older than DIGEST_MAX_AGE_MS (its refresh failed or took too long). */
  digestStale?: boolean;
  overnight: Report[];
  suggestions: number;
}

/** The part of the Brain the brief needs (tests pass a fake). */
export interface BriefBrain {
  start(text: string, channel: BrainChannel, options?: ChatOptions): { messageId: string; done: Promise<BrainReply> };
}

export interface BriefDeps {
  ctx: ToolContext;
  brain: BriefBrain;
  bus?: EventBus;
  /** The background job runner (digest); absent → the brief goes without a digest. */
  runner?: () => JobRunner | undefined;
  /** Number of Suggested to-dos (default: JARVIS Tasks; 0 when Notion isn't connected). */
  suggestions?: () => Promise<number>;
  now?: () => Date;
  refreshWaitMs?: number;
}

export interface BriefRun {
  /** The brief's brain message id (its reply streams as brain.* events with it). */
  messageId: string;
  /** Resolves once the brief's turn is on the brain's queue (gathering done), so a turn queued after it follows it. */
  queued: Promise<void>;
  done: Promise<BrainReply>;
}

interface BriefFile {
  /** The local day (YYYY-MM-DD) of the last brief. */
  day?: string;
  at?: string;
  text?: string;
}

/** Local date and hour parts of `at` in `timeZone`. */
function localParts(at: Date, timeZone: string): { y: number; m: number; d: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: n("year"), m: n("month"), d: n("day"), hour: n("hour"), minute: n("minute") };
}

/** YYYY-MM-DD of `at` in `timeZone`. */
export function dayIn(at: Date, timeZone: string): string {
  const { y, m, d } = localParts(at, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The offset of `timeZone` from UTC at `at`, in minutes. */
function offsetMinutes(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** 18:00 yesterday, Matthew's time. */
export function overnightSince(now: Date, timeZone: string): Date {
  const { y, m, d } = localParts(now, timeZone);
  const guess = Date.UTC(y, m - 1, d - 1, OVERNIGHT_FROM_HOUR);
  return new Date(guess - offsetMinutes(new Date(guess), timeZone) * 60_000);
}

const clock = (iso: string, timeZone: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
};
const firstLine = (text: string) => (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 200);

/** The instruction-prefixed prompt the chat brain turns into the spoken brief. */
export function briefPrompt(input: BriefInput): string {
  const { now, timeZone: tz, digest } = input;
  const day = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
  const lines = [
    "[Morning brief: an instruction from JARVIS itself, not something Matthew typed]",
    `Give Matthew his morning brief for ${day}. It will be read aloud: at most 60 seconds spoken (about 150 words), plain spoken sentences, no lists, no headings, no markdown, no links. Lead with today's events, then anything blocked or waiting on him, then what happened overnight, then anything else worth knowing. Skip empty parts; don't invent anything that isn't below. Don't call any tools.`,
    "",
  ];
  if (!digest) {
    lines.push("Today's calendar, mail and Slack: not available right now (say so in a few words).");
  } else {
    if (input.digestStale) lines.push(`(This digest is from ${clock(digest.generatedAt, tz)}; a fresh one wasn't ready.)`);
    lines.push(
      digest.events.length ? "Today's events:" : "Today's events: none.",
      ...digest.events.map((e) => `- ${clock(e.start, tz)}–${clock(e.end, tz)} ${e.title}${e.location ? ` (${e.location})` : ""}`),
    );
    lines.push(
      digest.sessionsWaiting.length ? "Sessions blocked or waiting on him:" : "Sessions blocked or waiting on him: none.",
      ...digest.sessionsWaiting.map((s) => `- ${s.job} (${s.status === "blocked" ? "blocked" : "needs a decision"}): ${s.line}`),
    );
    if (digest.tasksDue.length) lines.push(`To-dos due today: ${digest.tasksDue.map((t) => t.name).join("; ")}`);
    lines.push(`Mail worth reading: ${digest.inbox.length}${digest.inbox.length ? ` (${digest.inbox.map((m) => `${m.from}: ${m.line}`).join("; ")})` : ""}.`);
    lines.push(`Slack mentions and DMs: ${digest.slack.length}${digest.slack.length ? ` (${digest.slack.map((s) => `${s.who}: ${s.line}`).join("; ")})` : ""}.`);
  }
  lines.push(
    input.overnight.length ? `Session reports overnight (since ${OVERNIGHT_FROM_HOUR}:00 yesterday):` : "Session reports overnight: none.",
    ...input.overnight.map((r) => `- ${clock(r.receivedAt, tz)} ${r.jobId}: ${firstLine(r.text)}`),
  );
  lines.push(`Suggested to-dos waiting for his review: ${input.suggestions}.`);
  return lines.join("\n");
}

export class BriefService {
  private readonly file: JsonFile<BriefFile>;

  constructor(private readonly deps: BriefDeps) {
    this.file = new JsonFile<BriefFile>(deps.ctx.config.dataDir, "brief", {});
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  get timeZone(): string {
    return this.deps.ctx.config.timeZone ?? process.env.TZ ?? "UTC";
  }

  /** The last brief (day, time, text). */
  get last(): BriefFile {
    return this.file.get();
  }

  /**
   * For each Desk voice turn: true (and today is marked) when it's the first of the day between
   * 05:00 and 12:00 and no brief has been given today, so the caller gives the brief first.
   */
  claimFirstTurn(now = this.now()): boolean {
    const { hour } = localParts(now, this.timeZone);
    if (hour < AUTO_FROM_HOUR || hour >= AUTO_TO_HOUR) return false;
    const today = dayIn(now, this.timeZone);
    if (this.file.get().day === today) return false;
    void this.file.update((f) => ({ ...f, day: today }));
    return true;
  }

  /** Everything the brief is built from; refreshes the digest first when it's stale. */
  async gather(now = this.now()): Promise<BriefInput> {
    const tz = this.timeZone;
    const runner = this.runner();
    let result = runner?.result<Digest>("digest");
    const stale = (at?: string) => !at || now.getTime() - Date.parse(at) > DIGEST_MAX_AGE_MS;
    if (runner && stale(result?.at)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), this.deps.refreshWaitMs ?? REFRESH_WAIT_MS);
      });
      const fresh = await Promise.race([runner.run("digest").catch(() => undefined), wait]);
      clearTimeout(timer);
      result = (fresh as typeof result) ?? runner.result<Digest>("digest");
    }
    const since = overnightSince(now, tz).getTime();
    const overnight = this.deps.ctx.jarvis.store
      .recentReports(200)
      .filter((r) => Date.parse(r.receivedAt) >= since)
      .slice(0, MAX_REPORTS)
      .reverse(); // oldest first
    const suggestions = await (this.deps.suggestions ?? (() => tasks(this.deps.ctx).list("suggested").then((t) => t.length)))().catch(() => 0);
    return { now, timeZone: tz, digest: result?.data, digestStale: !!result && stale(result.at), overnight, suggestions };
  }

  /**
   * Gives the brief: gathers, then asks the chat brain on `channel`. The message id is known at once;
   * the reply streams as brain.* events and ends with `brief.ready`.
   */
  start(channel: BrainChannel, options: Pick<ChatOptions, "onDelta"> = {}): BriefRun {
    const messageId = randomUUID();
    const now = this.now();
    let onQueued!: () => void;
    const queued = new Promise<void>((r) => (onQueued = r));
    const done = (async () => {
      try {
        const input = await this.gather(now).catch((err: Error) => {
          throw new JarvisError(`Couldn't put the brief together: ${err.message}`);
        });
        const turn = this.deps.brain.start(briefPrompt(input), channel, { ...options, messageId });
        onQueued();
        const reply = await turn.done;
        const at = this.now().toISOString();
        await this.file.update(() => ({ day: dayIn(now, this.timeZone), at, text: reply.reply }));
        this.deps.bus?.publish({ type: "brief.ready", messageId, text: reply.reply, at });
        return reply;
      } finally {
        onQueued(); // a failed gather still lets the turn behind it go
      }
    })();
    return { messageId, queued, done };
  }

  private runner(): JobRunner | undefined {
    try {
      return this.deps.runner?.();
    } catch {
      return undefined;
    }
  }
}

/** The process's brief service, registered by index.ts (keyed by the JARVIS instance, so tests get their own). */
const services = new WeakMap<object, BriefService>();

export function useBrief(owner: object, service: BriefService): void {
  services.set(owner, service);
}

export function briefFor(owner: object): BriefService | undefined {
  return services.get(owner);
}
