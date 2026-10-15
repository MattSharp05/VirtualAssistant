// To-do suggestions (PRD: to-do list; mockup 6): JARVIS proposes to-dos and Matthew accepts or
// dismisses them. One module per source, each returning NewSuggestion[]:
//   - sessions.ts  (no LLM) a report that's blocked / waits on a decision: on every report, and every 30 min
//   - notionQa.ts  (no LLM) QA Pending tickets per project: every 30 min
//   - Slack + email: the worker job src/jobs/suggestions.ts (its own suggest_task tool), every 30 min
// All are written here, one at a time, to JARVIS Tasks as Status = Suggested. A dedupe key already in
// the database (any status) is skipped, so a dismissed suggestion never comes back.
import type { TaskItem } from "@jarvis/shared";
import { NotionApi } from "../notionWrite.js";
import type { Report } from "../store.js";
import type { NewSuggestion, TasksService } from "../tasks.js";
import { tasks } from "../tools/tasks.js";
import type { ToolContext } from "../tools/types.js";
import { notionQaSuggestions } from "./notionQa.js";
import { latestSessionSuggestions, sessionSuggestion } from "./sessions.js";

export const SUGGEST_EVERY_MS = 30 * 60_000;

export class Suggester {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: ToolContext,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get tasks(): TasksService {
    return tasks(this.ctx);
  }

  /** One write run at a time, so two identical reports in a row can't both get past the dedupe. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Writes the new ones as Suggested; returns what was created. */
  add(suggestions: NewSuggestion[]): Promise<TaskItem[]> {
    return this.serial(async () => this.write(suggestions, await this.tasks.keyed()));
  }

  private async write(suggestions: NewSuggestion[], known: Map<string, TaskItem>): Promise<TaskItem[]> {
    const made: TaskItem[] = [];
    for (const s of suggestions) {
      if (known.has(s.dedupeKey)) continue;
      const item = await this.tasks.suggest(s);
      known.set(s.dedupeKey, item);
      made.push(item);
    }
    return made;
  }

  /** On a session report (src/store.ts onReport). */
  fromReport(report: Report): Promise<TaskItem[]> {
    const s = sessionSuggestion(report, this.ctx.jarvis.store.getJob(report.jobId));
    return s ? this.add([s]) : Promise.resolve([]);
  }

  /** Every tracked session's latest report (catches up on any missed while JARVIS was down). */
  sessions(): Promise<TaskItem[]> {
    const { store } = this.ctx.jarvis;
    return this.add(latestSessionSuggestions(store.recentReports(200), store.recentJobs(100)));
  }

  /**
   * QA batches waiting in Notion. A project's Suggested QA row whose batch is gone (no QA Pending
   * tickets left, or a different set now) is Dismissed automatically.
   */
  notionQa(): Promise<{ added: TaskItem[]; dismissed: TaskItem[] }> {
    const token = this.ctx.config.notionToken;
    if (!token) return Promise.resolve({ added: [], dismissed: [] });
    return this.serial(async () => {
      const scan = await notionQaSuggestions(new NotionApi(token, this.fetchImpl));
      const known = await this.tasks.keyed();
      const current = new Set(scan.suggestions.map((s) => s.dedupeKey));
      const dismissed: TaskItem[] = [];
      for (const [key, t] of known) {
        if (t.status !== "Suggested" || t.source !== "Notion QA" || current.has(key) || !t.project || !scan.projects.has(t.project)) continue;
        dismissed.push(await this.tasks.setStatus(t, "Dismissed"));
      }
      return { added: await this.write(scan.suggestions, known), dismissed };
    });
  }

  /** Report events at once; sessions + Notion QA now and every 30 min (the worker job has its own schedule). */
  start(every: (name: string, ms: number, fn: () => Promise<void>) => unknown): void {
    if (!this.ctx.config.notionToken) return; // JARVIS Tasks lives in Notion
    const quietly = (what: string, work: () => Promise<unknown>) => () =>
      work().then(
        () => undefined,
        (err: Error) => console.warn(`suggestions (${what}) failed: ${err.message}`),
      );
    this.ctx.jarvis.store.onReport((r) => void quietly("report", () => this.fromReport(r))());
    const both = async () => {
      await quietly("sessions", () => this.sessions())();
      await quietly("Notion QA", () => this.notionQa())();
    };
    every("suggestions", SUGGEST_EVERY_MS, both);
    void both();
  }
}

/** One Suggester per process (keyed by the JARVIS instance, so tests get their own). */
const suggesters = new WeakMap<object, Suggester>();

export function suggesterFor(ctx: ToolContext): Suggester {
  let s = suggesters.get(ctx.jarvis);
  if (!s) suggesters.set(ctx.jarvis, (s = new Suggester(ctx)));
  return s;
}

/** Tests can put a specific instance in place. */
export function useSuggester(owner: object, suggester: Suggester): void {
  suggesters.set(owner, suggester);
}
