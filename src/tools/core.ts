// The implementations behind the sessions and Notion tool groups (sessions.ts, notion.ts):
// what each tool does, as text the model can read.

import { sessionActivity } from "../activity.js";
import { JarvisError, type Jarvis } from "../jarvis.js";
import { Notion } from "../notion.js";
import { parseSessionId, type Job } from "../store.js";

function ago(iso?: string): string {
  if (!iso) return "?";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

export class CoreTools {
  private readonly notion?: Notion;

  constructor(
    private readonly jarvis: Jarvis,
    notionToken?: string,
  ) {
    this.notion = notionToken ? new Notion(notionToken) : undefined;
  }

  async overview(): Promise<string> {
    const s = await this.jarvis.status();
    const usage = s.usage.available
      ? s.usage.windows.map((w) => `${w.name === "five_hour" ? "5-hour" : "weekly"} ${Math.round(w.percent)}%${w.resetsAt ? ` (resets ${w.resetsAt.slice(0, 16)} UTC)` : ""}`).join(", ")
      : `unavailable (${s.usage.reason})`;
    const reports = this.jarvis.store.recentReports(100);
    const jobs = this.jarvis.store.recentJobs(30).map((j) => {
      const last = reports.find((r) => r.jobId === j.id);
      return `- ${j.id} [${j.kind ?? "started"}] ${j.task.slice(0, 80)} — ${j.url}${last ? `\n  last report ${ago(last.receivedAt)}: ${last.text.split("\n")[0].slice(0, 200)}` : ""}`;
    });
    return [
      `Claude login: ${s.auth.loggedIn ? "ok" : "NOT signed in"}. Plan usage: ${usage}. Routine fires this hour: ${s.firesThisHour}/${s.firesPerHour}.`,
      "",
      jobs.length ? `Tracked sessions (most recently active first):\n${jobs.join("\n")}` : "No tracked sessions yet.",
    ].join("\n");
  }

  async sessions(): Promise<string> {
    const list = await this.jarvis.listSessions(true);
    if (!list.available) return `Can't list sessions: ${list.reason}`;
    const tracked = new Map(this.jarvis.store.recentJobs(1000).map((j) => [j.sessionId, j.id]));
    return list.sessions
      .slice(0, 30)
      .map((s) => `- ${s.title} — ${s.status ?? "?"}, active ${ago(s.lastActivityAt)}, id ${s.id}${tracked.has(s.id) ? `, tracked as ${tracked.get(s.id)}` : ""}`)
      .join("\n");
  }

  /** A tracked name, or a session id (which gets tracked under a name from its title). */
  private async resolve(target: string): Promise<Job> {
    const t = target.trim();
    const byName = this.jarvis.store.getJob(t);
    if (byName) return byName;
    const id = parseSessionId(t);
    if (!id) throw new JarvisError(`No session called "${t}". Use overview or list_cloud_sessions to find it.`);
    const title = (await this.jarvis.listSessions()).sessions.find((s) => s.id === id)?.title ?? "";
    return this.jarvis.pickSession(id, title);
  }

  async activity(target: string, limit = 15): Promise<string> {
    const job = await this.resolve(target);
    const act = await sessionActivity(job.sessionId, Math.min(Math.max(limit, 1), 40));
    const reports = this.jarvis.store
      .recentReports(100)
      .filter((r) => r.jobId === job.id)
      .slice(0, 3)
      .map((r) => `- ${ago(r.receivedAt)}: ${r.text.split("\n")[0].slice(0, 200)}`);
    const head = `${job.id} (${job.url})`;
    const reportText = reports.length ? `\nLatest reports:\n${reports.join("\n")}` : "";
    if (!act.available) return `${head}: live activity unavailable (${act.reason}).${reportText || " No reports either."}`;
    const lines = act.items.map((i) => `- ${i.at ? `${i.at.slice(11, 16)} ` : ""}${i.role}: ${i.text}`);
    return `${head}, recent activity (oldest first):\n${lines.join("\n")}${reportText}`;
  }

  async send(target: string, message: string): Promise<string> {
    const job = await this.resolve(target);
    const { ms } = await this.jarvis.sendMessage(job.id, message);
    return `Sent to ${job.id} in ${(ms / 1000).toFixed(1)}s. Its answer will arrive as a report.`;
  }

  async start(task: string, project?: string): Promise<string> {
    const { job, ms, fireNumber } = await this.jarvis.startJob(task, { project });
    const how = fireNumber ? ` via the routine fallback (fire ${fireNumber}/30 this hour)` : job.title ? `, titled "${job.title}"` : "";
    return `Started ${job.id} in ${(ms / 1000).toFixed(1)}s${how}: ${job.url}`;
  }

  async renameRoutineSessions(): Promise<string> {
    const { renamed, failed } = await this.jarvis.renameRoutineSessions();
    if (!renamed.length && !failed.length) return "Nothing to rename: every session JARVIS started already has its own title.";
    const lines = [
      ...(renamed.length ? [`Renamed ${renamed.length}: ${renamed.map((j) => `${j.id} → "${j.title}"`).join("; ")}.`] : []),
      ...(failed.length ? [`Couldn't rename ${failed.length} (${failed[0].error}).`] : []),
      "They're still routine runs, so the Claude Code sidebar won't list them (only the routine's runs page and JARVIS's Sessions window). New sessions appear in the sidebar.",
    ];
    return lines.join(" ");
  }

  private needNotion(): Notion {
    if (!this.notion) throw new JarvisError("Notion isn't connected: NOTION_TOKEN is not set in JARVIS's .env (see README).");
    return this.notion;
  }

  notionSearch(query: string): Promise<string> {
    return this.needNotion().search(query);
  }

  notionPage(id: string): Promise<string> {
    return this.needNotion().readPage(id);
  }

  notionQuery(id: string, limit: number): Promise<string> {
    return this.needNotion().queryDatabase(id, limit);
  }
}
