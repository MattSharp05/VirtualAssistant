// What a session report means for Matthew (PRD: notifications + mood). Every incoming report is
// classified; blocked / waiting-on-you / finished / failed ones become notices (Telegram + Desk), the
// rest stay quiet. The orb's mood follows: red if any tracked session's latest report is blocked;
// amber if one waits on a decision or the plan's 5-hour window is ≥ 75% used; else green.

import type { Mood } from "@jarvis/shared";
import type { EventBus } from "./events.js";
import type { Notifier } from "./notify.js";
import type { Report, Store } from "./store.js";
import type { PlanUsage } from "./usage.js";

export type ReportClass = "blocked" | "decision" | "finished" | "failed" | "info";

const RULES: [ReportClass, RegExp][] = [
  ["blocked", /⛔|\bblocked\b|\bblocking\b|\bstuck\b|can'?t (continue|proceed)/i],
  ["decision", /needs? (a |your )?decision|waiting (on|for) (matthew|you|your)|needs? (your|matthew'?s) (answer|input|ok|approval)|question for (you|matthew)|❓/i],
  ["failed", /\bci (is )?red\b|❌|\bfail(ed|ing|s)?\b|\bred main\b|\bbroke(n)?\b/i],
  ["finished", /\bbatch\b.*\b(done|finished|complete|handed)\b|ready for (qa|you|testing)|handed (it )?(to|over to) qa|\bqa pending\b|all .*merged|🏁/i],
];

export function classify(text: string): ReportClass {
  for (const [cls, re] of RULES) if (re.test(text)) return cls;
  return "info";
}

const NOTICE: Record<Exclude<ReportClass, "info">, { level: "alert" | "warn" | "info"; title: (job: string) => string }> = {
  blocked: { level: "alert", title: (job) => `⛔ ${job} is blocked` },
  decision: { level: "alert", title: (job) => `❓ ${job} needs a decision from you` },
  failed: { level: "warn", title: (job) => `⚠️ ${job}: something failed` },
  finished: { level: "info", title: (job) => `✅ ${job} finished` },
};

const AMBER_USAGE = 75;

export interface MoodState {
  mood: Mood;
  reason: string;
}

export function moodFrom(latest: { job: string; cls: ReportClass }[], usage?: PlanUsage): MoodState {
  const blocked = latest.filter((l) => l.cls === "blocked").map((l) => l.job);
  if (blocked.length) return { mood: "red", reason: `${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} blocked` };
  const waiting = latest.filter((l) => l.cls === "decision").map((l) => l.job);
  if (waiting.length) return { mood: "amber", reason: `${waiting.join(", ")} ${waiting.length === 1 ? "waits" : "wait"} on a decision` };
  const fiveHour = usage?.available ? usage.windows.find((w) => w.name === "five_hour") : undefined;
  if (fiveHour && fiveHour.percent >= AMBER_USAGE) return { mood: "amber", reason: `plan usage at ${Math.round(fiveHour.percent)}% of the 5-hour window` };
  return { mood: "green", reason: "all fine" };
}

export class ReportWatcher {
  private state: MoodState = { mood: "green", reason: "all fine" };
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    readonly notifier: Notifier,
    private readonly usage: () => Promise<PlanUsage | undefined> = async () => undefined,
  ) {}

  get mood(): MoodState {
    return { ...this.state };
  }

  /** Listens for reports and recomputes the mood every minute (plan usage changes on its own). */
  start(): void {
    this.store.onReport((r) => void this.onReport(r));
    void this.recompute();
    this.timer = setInterval(() => void this.recompute(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async onReport(report: Report): Promise<void> {
    // The Sessions window (JD-32) re-fetches its list.
    this.bus.publish({ type: "sessions.changed" });
    const cls = classify(report.text);
    if (cls !== "info") {
      const n = NOTICE[cls];
      const body = report.text.split("\n").find((l) => l.trim())?.trim().slice(0, 300);
      await this.notifier.notify({ title: n.title(report.jobId), body, level: n.level, link: this.store.getJob(report.jobId)?.url, telegram: true });
    }
    await this.recompute();
  }

  /** The latest report of each tracked session decides; publishes mood.changed when it changes. */
  async recompute(): Promise<MoodState> {
    const tracked = new Set(this.store.recentJobs(100).map((j) => j.id));
    const latest = new Map<string, Report>();
    for (const r of this.store.recentReports(200)) {
      if (!tracked.has(r.jobId)) continue;
      const seen = latest.get(r.jobId);
      if (!seen || seen.receivedAt <= r.receivedAt) latest.set(r.jobId, r);
    }
    const usage = await this.usage().catch(() => undefined);
    const next = moodFrom([...latest.values()].map((r) => ({ job: r.jobId, cls: classify(r.text) })), usage);
    if (next.mood !== this.state.mood || next.reason !== this.state.reason) {
      this.state = next;
      this.bus.publish({ type: "mood.changed", mood: next.mood, reason: next.reason });
    }
    return this.mood;
  }
}

/** The process's watcher, registered by index.ts (keyed by the JARVIS instance, so tests get their own). */
const watchers = new WeakMap<object, ReportWatcher>();

export function useReportWatcher(owner: object, watcher: ReportWatcher): void {
  watchers.set(owner, watcher);
}

export function reportWatcherFor(owner: object): ReportWatcher | undefined {
  return watchers.get(owner);
}
