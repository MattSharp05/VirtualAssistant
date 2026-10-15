// Suggestions from session reports (no LLM): a report that says a session is blocked or waits on a
// decision becomes "Decide <ticket>: <question>", once per session and ticket.
import { classify } from "../notifyRules.js";
import type { Job, Report } from "../store.js";
import type { NewSuggestion } from "../tasks.js";

const TICKET = /\b[A-Z][A-Z0-9]{1,5}-\d{1,5}\b/;
const LEAD = /^[\s⛔❓:—–\-·•*]+/;

/** The question in a report line, without the ticket id and the "needs a decision:" part. */
export function questionOf(line: string, ticket?: string): string {
  let q = (ticket ? line.replace(ticket, "") : line).replace(LEAD, "");
  const colon = q.indexOf(":");
  if (colon > 0 && q.slice(colon + 1).trim() && classify(q.slice(0, colon)) !== "info") q = q.slice(colon + 1);
  q = q.replace(LEAD, "").replace(/^is\s+/i, "").trim();
  return q.length > 120 ? `${q.slice(0, 119)}…` : q;
}

export function sessionSuggestion(report: Report, job?: Job): NewSuggestion | undefined {
  const cls = classify(report.text);
  if (cls !== "blocked" && cls !== "decision") return undefined;
  const lines = report.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => ["blocked", "decision"].includes(classify(l))) ?? lines[0] ?? "";
  const ticket = line.match(TICKET)?.[0] ?? report.text.match(TICKET)?.[0];
  const question = questionOf(line, ticket) || (cls === "blocked" ? "it's blocked" : "it needs a decision");
  return {
    name: `Decide ${ticket ?? report.jobId}: ${question}`,
    source: "Session",
    ...(job?.url ? { link: job.url } : {}),
    dedupeKey: `session:${job?.sessionId ?? report.jobId}:${ticket ?? "-"}`,
    why: `${report.jobId} ${cls === "blocked" ? "is blocked" : "is waiting on your decision"}: “${line.slice(0, 200)}”`,
  };
}

/** The latest report of each tracked session, as suggestions (catches reports missed while down). */
export function latestSessionSuggestions(reports: Report[], jobs: Job[]): NewSuggestion[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const latest = new Map<string, Report>();
  for (const r of reports) {
    const seen = latest.get(r.jobId);
    if (byId.has(r.jobId) && (!seen || seen.receivedAt <= r.receivedAt)) latest.set(r.jobId, r);
  }
  return [...latest.values()].map((r) => sessionSuggestion(r, byId.get(r.jobId))).filter((s): s is NewSuggestion => !!s);
}
