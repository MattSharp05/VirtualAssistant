// Titles for the sessions JARVIS starts (JD-69): short, verb-first, at most 60 characters, with the
// ticket ID in front when the task names one ("JD-65: Fix Today window timezone"). One cheap CLI
// call on the worker model writes it; if that fails, the task's first words are the title.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "./cloud.js";

export const MAX_TITLE = 60;

const TITLE_PROMPT = `You name Claude Code sessions. Reply with one title for a session that will do the task you are given: verb first (Fix, Add, Build, Write, Find…), at most 50 characters, sentence case, no ticket IDs, no quotes, no trailing period. Reply with the title only.`;

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
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1).replace(/\s+\S*$/, "");
  return (cut.length >= max / 2 ? cut : text.slice(0, max)).replace(/[\s,;:.-]+$/, "");
}

/** Tidies a title (the model's or the fallback's) and puts the ticket ID in front. */
export function finishTitle(raw: string, ticket?: string): string {
  let t = (raw.split("\n").find((l) => l.trim()) ?? "").trim();
  t = t.replace(/^(?:title\s*:\s*)/i, "").replace(/^["'`*“‘]+|["'`*”’]+$/g, "").trim();
  if (ticket) t = t.replace(new RegExp(`^\\[?${ticket}\\]?\\s*[:\\-–—]?\\s*`, "i"), "");
  t = t.replace(/[.\s]+$/, "");
  if (t) t = t[0].toUpperCase() + t.slice(1);
  const prefix = ticket ? `${ticket}: ` : "";
  return prefix + clip(t, MAX_TITLE - prefix.length);
}

/** The task's first words: "please can you fix the Today window's timezone" → "Fix the Today window's timezone". */
export function fallbackTitle(task: string, ticket?: string): string {
  let t = (task.split("\n").find((l) => l.trim()) ?? "").trim();
  if (ticket) t = t.replace(new RegExp(`\\b${ticket}\\b\\s*[:\\-–—]?\\s*`, "gi"), " ").trim();
  t = t.replace(/^(?:(?:hey\s+)?jarvis[,:]?\s+)?(?:(?:please|pls)\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, "");
  t = t.replace(/\s+/g, " ").replace(/[?!]+$/, "");
  return finishTitle(t || "JARVIS task", ticket);
}

/**
 * Asks the worker model for a title; undefined when the call fails (no login, timeout, empty
 * answer). Runs in an empty folder with no tools, so it's one short turn.
 */
export async function writeTitle(claudeBin: string, model: string | undefined, task: string, dataDir: string, timeoutMs = 20_000): Promise<string | undefined> {
  const cwd = join(dataDir, "titles");
  try {
    mkdirSync(cwd, { recursive: true });
    const args = ["-p", ...(model ? ["--model", model] : []), "--output-format", "json", "--system-prompt", TITLE_PROMPT, "--tools", "", "--strict-mcp-config", "--max-turns", "1"];
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

/** The title for a task: the model's when it answers, else the first words. */
export async function titleFor(task: string, ticket: string | undefined, write: (task: string) => Promise<string | undefined>): Promise<string> {
  const written = await write(task).catch(() => undefined);
  const title = written ? finishTitle(written, ticket) : "";
  // A title that is only the ticket ID says nothing.
  return title && title !== `${ticket}: ` && title.replace(`${ticket}: `, "").length >= 3 ? title : fallbackTitle(task, ticket);
}
