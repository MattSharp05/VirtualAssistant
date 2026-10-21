// Titles for the sessions JARVIS starts (JD-69, JD-81): "J<job number> · <Project> - <summary> (<role>)",
// e.g. "J17 · JARVIS Desk - adding session naming rule (orchestrator)", so the real session title in
// Claude (not just JARVIS's own records) says at a glance what a session is for. The summary is one
// cheap CLI call on the worker model; if that fails, the task's first words are the summary.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "./cloud.js";

/** The whole composed title (id + project + summary + role). */
export const MAX_TITLE = 90;
/** Just the summary clause. */
export const MAX_SUMMARY = 48;

/** The roles a session's title can show (JD-81). Independent of the `role:` tag (sessionStart.ts), which the Agents graph (JD-57) reads and which stays "builder"/"task" to avoid changing that graph's behaviour. */
export type TitleRole = "orchestrator" | "builder" | "design" | "scoping";

const SUMMARY_PROMPT = `You name Claude Code sessions. Reply with a short summary of the task you are given, to go after a project name in a title, e.g. "fixing the Today window's timezone" or "adding a packing list". Lower case, present participle (an -ing verb) first, at most 45 characters, no ticket IDs, no quotes, no trailing period. Reply with the summary only.`;

/**
 * The ticket the task names, e.g. "JD-65". With `prefixes` (the projects' ticket prefixes) only
 * those count, in any case; without, any upper-case `ABC-12`.
 */
export function ticketIdIn(task: string, prefixes: string[] = []): string | undefined {
  if (prefixes.length) {
    const alt = prefixes.map((p) => p.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean).join("|");
    const m = alt ? task.match(new RegExp(`\\b(${alt})-(\\d{1,6})\\b`, "i")) : null;
    return m ? `${m[1].toUpperCase()}-${m[2]}` : undefined;
  }
  return task.match(/\b([A-Z][A-Z0-9]{0,9}-\d{1,6})\b/)?.[1];
}

/** Cuts at a word boundary so the whole thing fits `max`. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1).replace(/\s+\S*$/, "");
  return (cut.length >= max / 2 ? cut : text.slice(0, max)).replace(/[\s,;:.-]+$/, "");
}

/** A task that reads as a build (fix/add/implement/…), not just a question or an investigation. */
const BUILD_WORDS = /\b(build|implement|fix|ship|wire up|wired up|write|writing|create|finish|polish|add|adding)\b/i;
const DESIGN_WORDS = /\b(prd|mockup|mock-up|wireframe|discovery interview|design doc|design the|interview matthew|new-project|plan-work)\b/i;
const SCOPING_WORDS = /\b(figure out|investigate|research|spike|scope out|which approach|where (?:should|does) this|recommend|look into|decide where)\b/i;

/**
 * The role shown in a session's title (JD-81): "builder" for a specific ticket being built,
 * "design" for PRD/discovery work, "scoping" for pure investigation with no ticket and no build
 * words, else "orchestrator" (the default for a JARVIS-directed task with no single ticket —
 * it may itself go on to start further sessions).
 */
export function deriveTitleRole(task: string, ticket: string | undefined): TitleRole {
  if (ticket && BUILD_WORDS.test(task)) return "builder";
  if (DESIGN_WORDS.test(task)) return "design";
  if (!ticket && SCOPING_WORDS.test(task) && !BUILD_WORDS.test(task)) return "scoping";
  if (ticket) return "builder";
  return "orchestrator";
}

/** Tidies a summary (the model's or the fallback's): one line, lower case, no trailing punctuation. */
export function finishSummary(raw: string): string {
  let t = (raw.split("\n").find((l) => l.trim()) ?? "").trim();
  t = t.replace(/^(?:summary\s*:\s*)/i, "").replace(/^["'`*“‘]+|["'`*”’]+$/g, "").trim();
  t = t.replace(/[.\s]+$/, "");
  if (t) t = t[0].toLowerCase() + t.slice(1);
  return clip(t, MAX_SUMMARY);
}

/** The task's first words, lower-cased: "please can you fix the Today window's timezone" → "fix the Today window's timezone". */
export function fallbackSummary(task: string, ticket?: string): string {
  let t = (task.split("\n").find((l) => l.trim()) ?? "").trim();
  if (ticket) t = t.replace(new RegExp(`\\b${ticket}\\b\\s*[:\\-–—]?\\s*`, "gi"), " ").trim();
  t = t.replace(/^(?:(?:hey\s+)?jarvis[,:]?\s+)?(?:(?:please|pls)\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, "");
  t = t.replace(/\s+/g, " ").replace(/[?!]+$/, "");
  if (t) t = t[0].toLowerCase() + t.slice(1);
  return clip(t || "jarvis task", MAX_SUMMARY);
}

/**
 * Asks the worker model for a summary; undefined when the call fails (no login, timeout, empty
 * answer). Runs in an empty folder with no tools, so it's one short turn.
 */
export async function writeTitle(claudeBin: string, model: string | undefined, task: string, dataDir: string, timeoutMs = 20_000): Promise<string | undefined> {
  const cwd = join(dataDir, "titles");
  try {
    mkdirSync(cwd, { recursive: true });
    const args = ["-p", ...(model ? ["--model", model] : []), "--output-format", "json", "--system-prompt", SUMMARY_PROMPT, "--tools", "", "--strict-mcp-config", "--max-turns", "1"];
    const { stdout } = await run(claudeBin, args, `Task:\n${task.slice(0, 4000)}`, timeoutMs, cwd);
    // --output-format json prints one result object (as the brain reads it; kept local to avoid an import cycle).
    for (const line of stdout.trim().split("\n").reverse()) {
      try {
        const r = JSON.parse(line) as { result?: unknown; is_error?: boolean };
        if (r && typeof r === "object" && "result" in r) return !r.is_error && typeof r.result === "string" && r.result.trim() ? r.result.trim() : undefined;
      } catch {
        // keep looking
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The summary clause for a task: the model's when it answers something useful, else the first words. */
export async function summaryFor(task: string, ticket: string | undefined, write: (task: string) => Promise<string | undefined>): Promise<string> {
  const written = await write(task).catch(() => undefined);
  const summary = written ? finishSummary(written) : "";
  // A bare ticket ID says nothing either.
  const useless = summary.length < 3 || (ticket && summary.toLowerCase() === ticket.toLowerCase());
  return useless ? fallbackSummary(task, ticket) : summary;
}

/** "J17 · JARVIS Desk - adding session naming rule (orchestrator)": the real title set on the Claude session. */
export function sessionDisplayTitle(jobId: string, projectName: string | undefined, summary: string, role: TitleRole): string {
  const prefix = `${jobId.toUpperCase()} · ${(projectName ?? "JARVIS").trim()} - `;
  const suffix = ` (${role})`;
  const room = Math.max(10, MAX_TITLE - prefix.length - suffix.length);
  return `${prefix}${clip(summary, room)}${suffix}`;
}
