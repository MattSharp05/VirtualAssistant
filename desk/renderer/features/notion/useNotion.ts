// The Notion window's data: pinned + recent from the server, a debounced title search, the open page
// with a back stack (child pages open inside the window), pin/unpin, and Ask JARVIS.
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotionPage, NotionPageRef, NotionPinnedResponse, NotionSearchResponse } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";
import { askAbout } from "./model";

export const SEARCH_DEBOUNCE_MS = 250;
const RECENT_MAX = 10;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const refOf = ({ id, title, kind, url, editedAt }: NotionPage): NotionPageRef => ({
  id,
  title,
  kind,
  ...(url ? { url } : {}),
  ...(editedAt ? { editedAt } : {}),
});

export interface NotionState {
  pinned: NotionPageRef[];
  recent: NotionPageRef[];
  query: string;
  setQuery(q: string): void;
  /** Undefined while the search box is empty. */
  results?: NotionPageRef[];
  searching: boolean;
  searchError?: string;
  page?: NotionPage;
  /** The id being opened (the page shown stays until it arrives). */
  opening?: string;
  pageError?: string;
  canGoBack: boolean;
  open(id: string): void;
  back(): void;
  togglePin(): void;
  ask(): void;
  /** Sent to JARVIS / failed, one line each. */
  note?: string;
  error?: string;
}

export function useNotion(initialId?: string): NotionState {
  const bridge = useBridge();
  const [pinned, setPinned] = useState<NotionPageRef[]>([]);
  const [recent, setRecent] = useState<NotionPageRef[]>([]);
  const [query, setQueryText] = useState("");
  const [results, setResults] = useState<NotionPageRef[]>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [page, setPage] = useState<NotionPage>();
  const [opening, setOpening] = useState<string>();
  const [pageError, setPageError] = useState<string>();
  const [history, setHistory] = useState<string[]>([]);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  // Only the newest page load and search may land.
  const pageSeq = useRef(0);
  const searchSeq = useRef(0);

  const load = useCallback(
    (id: string) => {
      const seq = ++pageSeq.current;
      setOpening(id);
      setPageError(undefined);
      bridge.request<NotionPage>(`/notion/page/${encodeURIComponent(id)}`).then(
        (p) => {
          if (seq !== pageSeq.current) return;
          setPage(p);
          setOpening(undefined);
          // The server puts it at the top of recent too.
          setRecent((r) => [refOf(p), ...r.filter((x) => x.id !== p.id)].slice(0, RECENT_MAX));
        },
        (err: unknown) => {
          if (seq !== pageSeq.current) return;
          setOpening(undefined);
          setPageError(`Couldn't open it: ${message(err)}`);
        },
      );
    },
    [bridge],
  );

  // Pinned and recent, then the page asked for (or the last one opened).
  useEffect(() => {
    let alive = true;
    bridge.request<NotionPinnedResponse>("/notion/pinned").then(
      (s) => {
        if (!alive) return;
        setPinned(s.pinned);
        setRecent(s.recent);
        const first = initialId ?? s.recent[0]?.id;
        if (first) load(first);
      },
      (err: unknown) => alive && setError(`Couldn't load pinned pages: ${message(err)}`),
    );
    return () => {
      alive = false;
    };
  }, [bridge, initialId, load]);

  // Search runs SEARCH_DEBOUNCE_MS after the last keystroke; an empty box shows pinned + recent.
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  const setQuery = useCallback(
    (value: string) => {
      setQueryText(value);
      clearTimeout(searchTimer.current);
      const q = value.trim();
      const seq = ++searchSeq.current;
      if (!q) {
        setResults(undefined);
        setSearching(false);
        setSearchError(undefined);
        return;
      }
      setSearching(true);
      searchTimer.current = setTimeout(() => {
        bridge.request<NotionSearchResponse>(`/notion/search?q=${encodeURIComponent(q)}`).then(
          (r) => {
            if (seq !== searchSeq.current) return;
            setResults(r.results);
            setSearchError(undefined);
            setSearching(false);
          },
          (err: unknown) => {
            if (seq !== searchSeq.current) return;
            setResults([]);
            setSearchError(message(err));
            setSearching(false);
          },
        );
      }, SEARCH_DEBOUNCE_MS);
    },
    [bridge],
  );

  const open = useCallback(
    (id: string) => {
      if (id === page?.id && !opening) return;
      if (page) setHistory((h) => [...h, page.id]);
      load(id);
    },
    [load, page, opening],
  );

  const back = useCallback(() => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    load(prev);
  }, [history, load]);

  const togglePin = useCallback(() => {
    if (!page) return;
    const was = pinned.find((p) => p.id === page.id);
    if (was?.fixed) return;
    setError(undefined);
    const path = `/notion/pinned/${encodeURIComponent(page.id)}`;
    // Optimistic; the server's answer replaces it, a failure puts it back.
    const before = pinned;
    setPinned(was ? pinned.filter((p) => p.id !== page.id) : [...pinned, refOf(page)]);
    const send = was
      ? bridge.request<NotionPinnedResponse>(`${path}/unpin`, {})
      : bridge.request<NotionPinnedResponse>(path, { title: page.title, kind: page.kind });
    send.then(
      (s) => setPinned(s.pinned),
      (err: unknown) => {
        setPinned(before);
        setError(`Couldn't ${was ? "unpin" : "pin"} “${page.title}”: ${message(err)}`);
      },
    );
  }, [bridge, page, pinned]);

  const ask = useCallback(() => {
    if (!page) return;
    setError(undefined);
    setNote(undefined);
    bridge.chat(askAbout(page), "desk-typed").then(
      () => setNote(`Asked JARVIS about “${page.title}”.`),
      (err: unknown) => setError(`Couldn't reach JARVIS: ${message(err)}`),
    );
  }, [bridge, page]);

  return {
    pinned,
    recent,
    query,
    setQuery,
    results,
    searching,
    searchError,
    page,
    opening,
    pageError,
    canGoBack: history.length > 0,
    open,
    back,
    togglePin,
    ask,
    note,
    error,
  };
}
