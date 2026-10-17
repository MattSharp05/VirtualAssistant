// The Sessions window (JD-32): cloud sessions merged with the ones JARVIS tracks, grouped by what
// needs Matthew.
//   GET  /api/desk/sessions               → DeskSession[] (needs-you first, then newest activity), each
//                                           with metrics: tokens, cost, context, wall time, status (JD-53)
//   GET  /api/desk/sessions/:id           → SessionDetail (activity, last 5 reports, link); its
//                                           session.metrics adds turns, tool calls, PRs, active time
//   POST /api/desk/sessions/:id/send { text } → SessionSendResponse (the Telegram/brain send path)
// :id is a tracked name ("mk") or a cloud session id. New reports publish sessions.changed
// (src/notifyRules.ts), and so does a message sent from here.
import type { DeskSession, ReportKind, SessionDetail, SessionGroup, SessionReport, SessionSendResponse } from "@jarvis/shared";
import { sessionActivity } from "../../activity.js";
import { JarvisError } from "../../jarvis.js";
import { classify } from "../../notifyRules.js";
import type { CloudSession } from "../../sessions.js";
import { parseSessionId, sessionUrl, type Job, type Report } from "../../store.js";
import { DeskHttpError, type DeskContext, type DeskRoute } from "./index.js";

/** No activity for this long and a session is idle. */
export const IDLE_AFTER_MS = 30 * 60 * 1000;

/** Reports that wait on Matthew: blocked, a decision, or a batch handed to QA. */
const NEEDS_YOU: ReportKind[] = ["blocked", "decision", "finished"];

export function groupFor(latestKind: ReportKind | undefined, lastActivity: string | undefined, now = Date.now()): SessionGroup {
  if (latestKind && NEEDS_YOU.includes(latestKind)) return "needs-you";
  if (lastActivity && now - Date.parse(lastActivity) < IDLE_AFTER_MS) return "working";
  return "idle";
}

const ORDER: Record<SessionGroup, number> = { "needs-you": 0, working: 1, idle: 2 };

const firstLine = (text: string) => (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 200);

const newest = (...times: (string | undefined)[]) => times.filter((t): t is string => Boolean(t)).sort().pop();

/**
 * One list from the cloud list and the tracked jobs (tracked ones the list misses still show).
 * Reports come oldest first, so of two in the same millisecond the later one counts.
 */
export function mergeSessions(cloud: CloudSession[], jobs: Job[], reports: Report[], now = Date.now()): DeskSession[] {
  const latest = new Map<string, Report>();
  for (const r of reports) {
    const seen = latest.get(r.jobId);
    if (!seen || seen.receivedAt <= r.receivedAt) latest.set(r.jobId, r);
  }
  const bySession = new Map(jobs.map((j) => [j.sessionId, j]));
  const make = (sessionId: string, job: Job | undefined, c: CloudSession | undefined): DeskSession => {
    const report = job ? latest.get(job.id) : undefined;
    const latestKind = report ? classify(report.text) : undefined;
    const lastActivity = newest(c?.lastActivityAt, report?.receivedAt, job?.lastMessageAt, job?.sessionUpdatedAt, c ? undefined : job?.createdAt);
    return {
      id: job?.id ?? sessionId,
      ...(job ? { name: job.id } : {}),
      sessionId,
      title: c?.title ?? job?.task ?? sessionId,
      ...(c?.status ? { status: c.status } : {}),
      ...(lastActivity ? { lastActivity } : {}),
      group: groupFor(latestKind, lastActivity, now),
      ...(report ? { latestReport: firstLine(report.text), latestKind } : {}),
      url: c?.url ?? job?.url ?? sessionUrl(sessionId),
    };
  };
  const seen = new Set<string>();
  const out: DeskSession[] = [];
  for (const c of cloud) {
    seen.add(c.id);
    out.push(make(c.id, bySession.get(c.id), c));
  }
  for (const j of jobs) if (!seen.has(j.sessionId)) out.push(make(j.sessionId, j, undefined));
  return out.sort((a, b) => ORDER[a.group] - ORDER[b.group] || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}

async function listFor(ctx: DeskContext, withMetrics = false): Promise<DeskSession[]> {
  const { jarvis } = ctx;
  const cloud = await jarvis.listSessions();
  const list = mergeSessions(cloud.available ? cloud.sessions : [], jarvis.store.recentJobs(1000), jarvis.store.recentReports(200).reverse());
  if (!withMetrics) return list;
  const metrics = await jarvis.metrics.summaries(list.map((s) => s.sessionId));
  return list.map((s) => (metrics.has(s.sessionId) ? { ...s, metrics: metrics.get(s.sessionId) } : s));
}

async function find(ctx: DeskContext, id: string): Promise<DeskSession> {
  const sessionId = parseSessionId(id);
  const session = (await listFor(ctx)).find((s) => s.id === id.toLowerCase() || (sessionId && s.sessionId === sessionId));
  if (!session) throw new DeskHttpError(404, `No session ${id}.`);
  return session;
}

const routes: DeskRoute[] = [
  { method: "GET", path: "/sessions", handler: ({ ctx }) => listFor(ctx, true) },
  {
    method: "GET",
    path: "/sessions/:id",
    handler: async ({ params, ctx }): Promise<SessionDetail> => {
      const session = await find(ctx, params.id);
      const reports: SessionReport[] = session.name
        ? ctx.jarvis.store
            .recentReports(200)
            .filter((r) => r.jobId === session.name)
            .slice(0, 5)
            .map((r) => ({ text: r.text, at: r.receivedAt, kind: classify(r.text) }))
        : [];
      const [activity, metrics] = await Promise.all([sessionActivity(session.sessionId, 15), ctx.jarvis.metrics.full(session.sessionId)]);
      return { session: metrics ? { ...session, metrics } : session, activity, reports, link: session.url };
    },
  },
  {
    method: "POST",
    path: "/sessions/:id/send",
    handler: async ({ params, body, ctx }): Promise<SessionSendResponse> => {
      const text = String(body.text ?? "").trim();
      if (!text) throw new DeskHttpError(400, "text is empty");
      const session = await find(ctx, params.id);
      try {
        // An untracked session gets a name from its title first (as the brain's send_to_session does).
        const name = session.name ?? ctx.jarvis.pickSession(session.sessionId, session.title).id;
        const { job, ms } = await ctx.jarvis.sendMessage(name, text);
        ctx.bus.publish({ type: "sessions.changed" });
        return { ok: true, name: job.id, ms };
      } catch (err) {
        if (err instanceof JarvisError) throw new DeskHttpError(400, err.message);
        throw err;
      }
    },
  },
];

export default routes;
