// The Today digest (PRD: Today digest; mockup 3): today's events, mail worth reading, Slack mentions
// and DMs from the worker, plus tasks due and sessions waiting on Matthew from JARVIS itself.
import type { Digest, DigestEvent, DigestMail, DigestSession, DigestSlack } from "@jarvis/shared";
import { JarvisError } from "../jarvis.js";
import { classify } from "../notifyRules.js";
import { tasks } from "../tools/tasks.js";
import type { JobDef } from "./index.js";

type WorkerPart = Pick<Digest, "events" | "inbox" | "skippedCount" | "slack">;

const MAX_ITEMS = 6;
const str = (description: string) => ({ type: "string", description });

const fail = (why: string): never => {
  throw new JarvisError(`submit_digest rejected: ${why}. Fix it and call submit_digest again.`);
};
const text = (v: unknown, field: string, optional = false): string | undefined => {
  if (v === undefined || v === null || v === "") return optional ? undefined : fail(`${field} is required`);
  if (typeof v !== "string") return fail(`${field} must be a string`);
  return v.slice(0, 300);
};
const list = (v: unknown, field: string): Record<string, unknown>[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return fail(`${field} must be a list`);
  return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
};
const opt = <K extends string>(key: K, value: string | undefined) => (value ? { [key]: value } : {}) as Partial<Record<K, string>>;

export function validateDigest(input: unknown): WorkerPart {
  if (!input || typeof input !== "object") return fail("send an object");
  const i = input as Record<string, unknown>;
  const events: DigestEvent[] = list(i.events, "events").map((e, n) => ({
    start: text(e.start, `events[${n}].start`)!,
    end: text(e.end, `events[${n}].end`)!,
    title: text(e.title, `events[${n}].title`)!,
    calendar: text(e.calendar, `events[${n}].calendar`, true) ?? "primary",
    ...opt("location", text(e.location, "location", true)),
    ...opt("link", text(e.link, "link", true)),
  }));
  const inbox: DigestMail[] = list(i.inbox, "inbox").slice(0, MAX_ITEMS).map((m, n) => ({
    from: text(m.from, `inbox[${n}].from`)!,
    subject: text(m.subject, `inbox[${n}].subject`)!,
    line: text(m.line, `inbox[${n}].line`)!,
    receivedAt: text(m.receivedAt, `inbox[${n}].receivedAt`)!,
    ...opt("link", text(m.link, "link", true)),
  }));
  const slack: DigestSlack[] = list(i.slack, "slack").slice(0, MAX_ITEMS).map((s, n) => ({
    who: text(s.who, `slack[${n}].who`)!,
    where: text(s.where, `slack[${n}].where`)!,
    line: text(s.line, `slack[${n}].line`)!,
    at: text(s.at, `slack[${n}].at`)!,
    ...opt("link", text(s.link, "link", true)),
  }));
  const skipped = i.skippedCount === undefined ? 0 : Number(i.skippedCount);
  if (!Number.isInteger(skipped) || skipped < 0) fail("skippedCount must be a whole number");
  return { events: events.sort((a, b) => a.start.localeCompare(b.start)), inbox, skippedCount: skipped, slack };
}

const job: JobDef<WorkerPart, Digest> = {
  name: "digest",
  schedule: { minutes: 30, fromHour: 7, toHour: 22 },
  submitTool: {
    name: "submit_digest",
    description: "Hand back today's digest (worker only). Call exactly once when you've gathered everything.",
    inputSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          description: "Today's calendar events, in order",
          items: {
            type: "object",
            properties: { start: str("ISO start"), end: str("ISO end"), title: str("Title"), location: str("Where (optional)"), link: str("Meeting/event link (optional)"), calendar: str("Calendar name") },
            required: ["start", "end", "title", "calendar"],
          },
        },
        inbox: {
          type: "array",
          description: `Unread mail worth Matthew's attention (max ${MAX_ITEMS})`,
          items: {
            type: "object",
            properties: { from: str("Sender name"), subject: str("Subject"), line: str("One line: why it matters / what's asked"), receivedAt: str("ISO time"), link: str("Gmail link (optional)") },
            required: ["from", "subject", "line", "receivedAt"],
          },
        },
        skippedCount: { type: "integer", description: "Unread mail you left out (newsletters, notifications…)" },
        slack: {
          type: "array",
          description: `Slack mentions and DMs to Matthew since yesterday (max ${MAX_ITEMS})`,
          items: {
            type: "object",
            properties: { who: str("Person"), where: str("#channel or DM"), line: str("What they said/asked, one line"), at: str("ISO time"), link: str("Permalink (optional)") },
            required: ["who", "where", "line", "at"],
          },
        },
      },
      required: ["events", "inbox", "skippedCount", "slack"],
    },
  },
  prompt: (now) => {
    const tz = process.env.TZ || "UTC";
    const day = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz });
    return [
      `Build Matthew's Today digest. Today is ${day} (${tz}); it's now ${now.toISOString()}.`,
      "1. Calendar: list_events for today (00:00 to 23:59 his time) across his calendars. Include every event, in order.",
      `2. Gmail: search_threads for "is:unread newer_than:1d -category:promotions -category:social -category:updates". Keep at most ${MAX_ITEMS} that a person would want to read today (from people, asks, deadlines), with one line on why; count the rest in skippedCount.`,
      `3. Slack: slack_search_public_and_private for "to:me after:yesterday" (mentions) and his DMs since yesterday. Keep at most ${MAX_ITEMS}, newest first, one line each.`,
      "4. Call submit_digest once with what you found. If a source isn't connected or fails, use an empty list for it.",
    ].join("\n");
  },
  validate: validateDigest,
  finish: async (part, ctx, now) => {
    const tasksDue = await tasks(ctx)
      .list("today")
      .catch(() => []);
    const { store } = ctx.jarvis;
    const tracked = new Map(store.recentJobs(100).map((j) => [j.id, j]));
    const latest = new Map<string, { text: string; receivedAt: string }>();
    for (const r of store.recentReports(200)) if (tracked.has(r.jobId) && !latest.has(r.jobId)) latest.set(r.jobId, r);
    const sessionsWaiting: DigestSession[] = [];
    for (const [jobId, r] of latest) {
      const cls = classify(r.text);
      if (cls !== "blocked" && cls !== "decision") continue;
      const line = r.text.split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "";
      sessionsWaiting.push({ job: jobId, status: cls, line, at: r.receivedAt, ...opt("link", tracked.get(jobId)?.url) });
    }
    return { generatedAt: now.toISOString(), ...part, tasksDue, sessionsWaiting };
  },
  event: (d) => ({ type: "today.updated", generatedAt: d.generatedAt }),
};

export default job;
