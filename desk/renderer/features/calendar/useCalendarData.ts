import { useEffect, useState } from "react";
import type {
  CalendarChange,
  CalendarFreeResponse,
  CalendarResponse,
  DeskBridge,
  FreeSlot,
} from "@jarvis/shared";
import { mergeChanges, rangeQuery, type VisibleRange } from "./calendarMath";

export interface CalendarData {
  /** The visible range's events; undefined while the worker fetches it (the skeleton shows). */
  range?: CalendarResponse;
  error?: string;
  free?: FreeSlot[];
  changes?: CalendarChange[];
  /** Bumped by every calendar.changed (the Undo button waits for the next one). */
  changeCount: number;
  retry(): void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The window's data: GET /calendar for the visible range, /calendar/free and /calendar/log, all
 * fetched again when JARVIS changes the calendar (calendar.changed; the server drops its cache then).
 */
export function useCalendarData(bridge: DeskBridge, visible: VisibleRange): CalendarData {
  const query = rangeQuery(visible);
  const [result, setResult] = useState<{ query: string; data?: CalendarResponse; error?: string }>();
  const [free, setFree] = useState<FreeSlot[]>();
  const [changes, setChanges] = useState<CalendarChange[]>();
  const [changeCount, setChangeCount] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(
    () =>
      bridge.subscribe((e) => {
        if (e.type !== "calendar.changed") return;
        setChanges((old) => mergeChanges([e.entry], old ?? []));
        setChangeCount((n) => n + 1);
      }),
    [bridge],
  );

  useEffect(() => {
    let alive = true;
    bridge
      .request<CalendarResponse>(`/calendar?${query}`)
      .then((data) => alive && setResult({ query, data }))
      // A failed refresh keeps what's on screen.
      .catch(
        (err) =>
          alive && setResult((r) => (r?.query === query && r.data ? r : { query, error: message(err) })),
      );
    return () => {
      alive = false;
    };
  }, [bridge, query, changeCount, attempt]);

  useEffect(() => {
    let alive = true;
    bridge
      .request<CalendarFreeResponse>("/calendar/free")
      .then((r) => alive && setFree(r.slots))
      .catch(() => alive && setFree((f) => f ?? []));
    bridge
      .request<{ changes: CalendarChange[] }>("/calendar/log")
      .then((r) => alive && setChanges((old) => mergeChanges(r.changes, old ?? [])))
      .catch(() => alive && setChanges((c) => c ?? []));
    return () => {
      alive = false;
    };
  }, [bridge, changeCount]);

  const current = result?.query === query ? result : undefined;
  return {
    ...(current?.data ? { range: current.data } : {}),
    ...(current?.error ? { error: current.error } : {}),
    ...(free ? { free } : {}),
    ...(changes ? { changes } : {}),
    changeCount,
    retry: () => {
      setResult(undefined);
      setAttempt((n) => n + 1);
    },
  };
}
