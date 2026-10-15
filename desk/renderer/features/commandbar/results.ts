// What the command bar lists (JD-28): windows, sessions, Notion pages and layouts that match the text,
// best first (max 8), then always "Ask JARVIS: <text>". Pure, so ranking is unit-tested.
import type { DeskSession } from "@jarvis/shared";
import { bestScore } from "./fuzzy";

export const MAX_MATCHES = 8;

/** A Notion page from /notion/search (JD-34 owns the route; only these fields are used). */
export interface NotionHit {
  id: string;
  title: string;
}

/** A saved layout (JD-37 owns their shape): its name and the windows it opens, when it lists them. */
export interface LayoutHit {
  name: string;
  windows: string[];
}

export interface WindowHit {
  id: string;
  title: string;
  icon: string;
}

export type CommandResult =
  | { kind: "window"; key: string; label: string; icon: string; id: string }
  | { kind: "session"; key: string; label: string; detail?: string; id: string }
  | { kind: "notion"; key: string; label: string; id: string }
  | { kind: "layout"; key: string; label: string; windows: string[] }
  | { kind: "ask"; key: string; label: string; text: string };

export interface Sources {
  windows: WindowHit[];
  sessions: DeskSession[];
  notion: NotionHit[];
  layouts: LayoutHit[];
}

/** Ties go to windows, then sessions, Notion pages and layouts. */
const KIND_ORDER = { window: 0, session: 1, notion: 2, layout: 3, ask: 4 } as const;

export function buildResults(text: string, sources: Sources): CommandResult[] {
  const query = text.trim();
  if (!query) {
    // Nothing typed yet: the windows, so ↵ still does something useful.
    return sources.windows.slice(0, MAX_MATCHES).map(windowResult);
  }
  const scored: { score: number; result: CommandResult }[] = [
    ...sources.windows.map((w) => ({ score: bestScore(query, [w.title, w.id]), result: windowResult(w) })),
    ...sources.sessions.map((s) => ({
      score: bestScore(query, [s.name, s.title, s.id]),
      result: {
        kind: "session" as const,
        key: `session:${s.id}`,
        label: s.name ?? s.title,
        ...(s.name && s.title !== s.name ? { detail: s.title } : {}),
        id: s.id,
      },
    })),
    ...sources.notion.map((p) => ({
      // The server already matched these; keep them even when the title alone doesn't.
      score: Math.max(1, bestScore(query, [p.title])),
      result: { kind: "notion" as const, key: `notion:${p.id}`, label: p.title, id: p.id },
    })),
    ...sources.layouts.map((l) => ({
      score: bestScore(query, [l.name]),
      result: { kind: "layout" as const, key: `layout:${l.name}`, label: l.name, windows: l.windows },
    })),
  ];
  const matches = scored
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        KIND_ORDER[a.result.kind] - KIND_ORDER[b.result.kind] ||
        a.result.label.localeCompare(b.result.label),
    )
    .slice(0, MAX_MATCHES)
    .map((s) => s.result);
  return [...matches, { kind: "ask", key: "ask", label: `Ask JARVIS: “${query}”`, text: query }];
}

function windowResult(w: WindowHit): CommandResult {
  return { kind: "window", key: `window:${w.id}`, label: w.title, icon: w.icon, id: w.id };
}

/** /notion/search's answer, whatever JD-34 settles on: a list, or { results | pages: [...] }. */
export function notionHits(answer: unknown): NotionHit[] {
  const list = Array.isArray(answer)
    ? answer
    : answer && typeof answer === "object"
      ? ((answer as { results?: unknown }).results ?? (answer as { pages?: unknown }).pages)
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p: unknown) => {
    const { id, title } = (p ?? {}) as { id?: unknown; title?: unknown };
    return typeof id === "string" && typeof title === "string" && title ? [{ id, title }] : [];
  });
}

/**
 * The saved layouts setting: { name: { windows: [{ windowId, bounds, displayId }, …] } } (JD-37), or
 * window ids ({ windows: ["chat", …] } or a bare list).
 */
export function layoutHits(setting: unknown): LayoutHit[] {
  if (!setting || typeof setting !== "object") return [];
  return Object.entries(setting as Record<string, unknown>).map(([name, value]) => {
    const raw = Array.isArray(value) ? value : (value as { windows?: unknown } | null)?.windows;
    const windows = (Array.isArray(raw) ? raw : []).flatMap((w: unknown) =>
      typeof w === "string"
        ? [w]
        : typeof (w as { windowId?: unknown })?.windowId === "string"
          ? [(w as { windowId: string }).windowId]
          : typeof (w as { id?: unknown })?.id === "string"
            ? [(w as { id: string }).id]
            : [],
    );
    return { name, windows };
  });
}
