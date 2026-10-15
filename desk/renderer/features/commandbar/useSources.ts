// Where the command bar's results come from (JD-28): the registered windows, the sessions and saved
// layouts (fetched once when the bar opens) and Notion pages (searched as Matthew types, debounced).
// A source the server doesn't have yet (or that fails) just contributes nothing.
import { useEffect, useMemo, useState } from "react";
import type { DeskBridge, DeskSession } from "@jarvis/shared";
import { features } from "../registry";
import {
  layoutHits,
  notionHits,
  type LayoutHit,
  type NotionHit,
  type Sources,
  type WindowHit,
} from "./results";

export const NOTION_DEBOUNCE_MS = 200;
/** Notion is only searched from this many characters. */
const NOTION_MIN_CHARS = 2;

/** Windows Matthew can open: framed features, without the placeholder. */
export function openableWindows(): WindowHit[] {
  return features
    .filter((f) => f.framed !== false && f.id !== "hello")
    .map((f) => ({ id: f.id, title: f.title, icon: f.icon }));
}

export function useSources(bridge: DeskBridge, text: string): Sources {
  // Read on first render, not at import: the registry imports this feature while it's being built.
  const [windows] = useState(openableWindows);
  const [sessions, setSessions] = useState<DeskSession[]>([]);
  const [layouts, setLayouts] = useState<LayoutHit[]>([]);
  const [notion, setNotion] = useState<{ query: string; hits: NotionHit[] }>({ query: "", hits: [] });

  useEffect(() => {
    let live = true;
    bridge
      .request<DeskSession[]>("/sessions")
      .then((list) => live && Array.isArray(list) && setSessions(list))
      .catch(() => {});
    bridge.settings
      .get("layouts")
      .then((value) => live && setLayouts(layoutHits(value)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bridge]);

  const query = text.trim();
  useEffect(() => {
    if (query.length < NOTION_MIN_CHARS) return;
    let live = true;
    const timer = setTimeout(() => {
      bridge
        .request(`/notion/search?q=${encodeURIComponent(query)}`)
        .then((answer) => live && setNotion({ query, hits: notionHits(answer) }))
        .catch(() => live && setNotion({ query, hits: [] }));
    }, NOTION_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bridge, query]);

  return useMemo(
    () => ({
      windows,
      sessions,
      // Pages found for older text stay out (they'd flash in after the text changed).
      notion: notion.query === query ? notion.hits : [],
      layouts,
    }),
    [windows, sessions, notion, query, layouts],
  );
}
