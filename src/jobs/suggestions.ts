// To-do suggestions from Slack and email (PRD: to-do list; mockup 6): the worker looks for direct
// asks of Matthew in the last 24 h that he hasn't answered and hands back at most 5 through
// suggest_task. They're written to JARVIS Tasks as Suggested by src/suggest/ (deduped by message link).
import type { TaskItem } from "@jarvis/shared";
import { JarvisError } from "../jarvis.js";
import { suggesterFor } from "../suggest/index.js";
import type { NewSuggestion } from "../tasks.js";
import type { JobDef } from "./index.js";

export const MAX_SUGGESTIONS = 5;
const str = (description: string) => ({ type: "string", description });

const fail = (why: string): never => {
  throw new JarvisError(`suggest_task rejected: ${why}. Fix it and call suggest_task again.`);
};
const text = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) return fail(`${field} is required`);
  return v.trim().slice(0, max);
};

export function validateSuggestions(input: unknown): NewSuggestion[] {
  if (!input || typeof input !== "object") return fail("send an object");
  const list = (input as Record<string, unknown>).suggestions;
  if (!Array.isArray(list)) return fail("suggestions must be a list (empty if there's nothing)");
  return list.slice(0, MAX_SUGGESTIONS).map((raw, n) => {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (s.source !== "Slack" && s.source !== "Email") fail(`suggestions[${n}].source must be Slack or Email`);
    const link = text(s.link, `suggestions[${n}].link`, 500);
    if (!/^https?:\/\//.test(link)) fail(`suggestions[${n}].link must be the message's https link`);
    const due = s.due === undefined || s.due === null || s.due === "" ? undefined : text(s.due, `suggestions[${n}].due`, 30);
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) fail(`suggestions[${n}].due must be YYYY-MM-DD`);
    return {
      name: text(s.name, `suggestions[${n}].name`, 120),
      source: s.source as "Slack" | "Email",
      link,
      dedupeKey: link,
      why: text(s.why, `suggestions[${n}].why`, 300),
      ...(due ? { due } : {}),
    };
  });
}

const job: JobDef<NewSuggestion[], { added: TaskItem[]; offered: number }> = {
  name: "suggestions",
  schedule: { minutes: 30, fromHour: 7, toHour: 22 },
  submitTool: {
    name: "suggest_task",
    description: `Hand back to-do suggestions from Slack and email (worker only). Call exactly once, with at most ${MAX_SUGGESTIONS} (an empty list is fine).`,
    inputSchema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          maxItems: MAX_SUGGESTIONS,
          items: {
            type: "object",
            properties: {
              name: str("The to-do, short, starting with a verb (e.g. 'Reply to Priya about the onboarding copy')"),
              source: { type: "string", enum: ["Slack", "Email"] },
              link: str("The message's permalink (Slack) or Gmail link: required"),
              why: str("One line: who asked what, and when"),
              due: str("YYYY-MM-DD if they gave a deadline (optional)"),
            },
            required: ["name", "source", "link", "why"],
          },
        },
      },
      required: ["suggestions"],
    },
  },
  prompt: (now) => {
    const tz = process.env.TZ || "UTC";
    return [
      `Find direct asks of Matthew from the last 24 hours that he hasn't answered yet. It's now ${now.toISOString()} (${tz}).`,
      "1. Slack: slack_search_public_and_private for \"to:me after:yesterday\" (mentions) and read his DMs since yesterday. Keep messages that ask him for something (a decision, a review, a reply, a file) and where he hasn't replied after it in the thread or DM.",
      "2. Gmail: search_threads for \"newer_than:1d -category:promotions -category:social -category:updates -from:me\". Keep emails from people that ask him for a decision or a reply, and whose thread has no reply from him after the ask.",
      "3. Skip newsletters, notifications, FYIs, and anything already handled.",
      `4. Call suggest_task once with at most ${MAX_SUGGESTIONS}, most important first: each with a short to-do name, its source, the message's link (required: skip a message you can't link to) and one line on why. If a source isn't connected or fails, leave it out; an empty list is fine.`,
    ].join("\n");
  },
  validate: validateSuggestions,
  finish: async (suggestions, ctx) => ({ added: await suggesterFor(ctx).add(suggestions), offered: suggestions.length }),
};

export default job;
