// The Today window's state (JD-33): the digest from GET /today, kept live by today.updated and
// tasks.changed, plus what its buttons do (refresh, tick a to-do, play the morning brief).
import { useCallback, useEffect, useRef, useState } from "react";
import type { BriefResponse, DeskBridge, TaskItem, TasksResponse, TodayResponse } from "@jarvis/shared";

/** While a refresh runs, GET /today this often in case today.updated is missed. */
export const REFRESH_POLL_MS = 15_000;
/** How long "Brief on its way" shows after asking for the morning brief. */
export const BRIEF_SENT_MS = 4_000;
/** How often the window re-reads the clock (stale indicator, next-up). */
const TICK_MS = 30_000;

export type BriefState = "unavailable" | "ready" | "asking" | "sent";

export interface TodayState {
  response?: TodayResponse;
  /** Date.now() when the response arrived. */
  fetchedAt: number;
  now: number;
  /** The to-dos due today: the digest's, then GET /tasks?view=today after tasks.changed. */
  tasks: TaskItem[];
  loadError?: string;
  actionError?: string;
  refreshing: boolean;
  brief: BriefState;
  reload(): void;
  refresh(): void;
  setDone(task: TaskItem, done: boolean): void;
  playBrief(): void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** POST /brief exists once the server has the morning brief (JD-23); a GET there answers 405. */
async function hasBrief(bridge: DeskBridge): Promise<boolean> {
  try {
    await bridge.request("/brief");
    return true;
  } catch (err) {
    return /405|method not allowed/i.test(message(err));
  }
}

export function useToday(bridge: DeskBridge): TodayState {
  const [response, setResponse] = useState<TodayResponse>();
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [brief, setBrief] = useState<BriefState>("unavailable");
  const alive = useRef(true);

  const load = useCallback(
    () =>
      bridge.request<TodayResponse>("/today").then(
        (r) => {
          if (!alive.current) return;
          const at = Date.now();
          setResponse(r);
          setFetchedAt(at);
          setNow(at);
          setTasks(r.digest?.tasksDue ?? []);
          setLoadError(undefined);
          if (!r.running) setRefreshing(false);
        },
        (err: unknown) => void (alive.current && setLoadError(message(err))),
      ),
    [bridge],
  );

  // A to-do changed somewhere (here, Telegram, Notion): re-read what's due, keeping the ones ticked
  // here in place (checked) so they can be unticked.
  const loadTasks = useCallback(async () => {
    try {
      const { tasks: fresh } = await bridge.request<TasksResponse>("/tasks?view=today");
      if (!alive.current) return;
      setTasks((old) => [
        ...fresh,
        ...old.filter((t) => t.status === "Done" && !fresh.some((f) => f.id === t.id)),
      ]);
    } catch {
      // The digest's list stays; the next today.updated brings a fresh one.
    }
  }, [bridge]);

  useEffect(() => {
    alive.current = true;
    void load();
    void hasBrief(bridge).then((ok) => alive.current && ok && setBrief("ready"));
    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === "today.updated") void load();
      if (event.type === "tasks.changed") void loadTasks();
    });
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      alive.current = false;
      unsubscribe();
      clearInterval(tick);
    };
  }, [bridge, load, loadTasks]);

  const running = refreshing || !!response?.running;
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => void load(), REFRESH_POLL_MS);
    return () => clearInterval(poll);
  }, [running, load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setActionError(undefined);
    bridge.request("/today/refresh", {}).catch((err: unknown) => {
      if (!alive.current) return;
      setRefreshing(false);
      setActionError(`Couldn't refresh: ${message(err)}`);
    });
  }, [bridge]);

  const setDone = useCallback(
    (task: TaskItem, done: boolean) => {
      const mark = (status: TaskItem["status"]) =>
        setTasks((list) => list.map((t) => (t.id === task.id ? { ...t, status } : t)));
      mark(done ? "Done" : "Open");
      setActionError(undefined);
      bridge
        .request(`/tasks/${encodeURIComponent(task.id)}/${done ? "done" : "reopen"}`, {})
        .catch((err: unknown) => {
          if (!alive.current) return;
          mark(task.status);
          setActionError(`Couldn't update “${task.name}”: ${message(err)}`);
        });
    },
    [bridge],
  );

  const playBrief = useCallback(() => {
    setBrief("asking");
    setActionError(undefined);
    bridge
      .request<BriefResponse>("/brief", {})
      .then(() => {
        if (!alive.current) return;
        setBrief("sent");
        setTimeout(() => alive.current && setBrief("ready"), BRIEF_SENT_MS);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setBrief("ready");
        setActionError(`Couldn't start the morning brief: ${message(err)}`);
      });
  }, [bridge]);

  return {
    ...(response ? { response } : {}),
    fetchedAt,
    now,
    tasks,
    ...(loadError ? { loadError } : {}),
    ...(actionError ? { actionError } : {}),
    refreshing: running,
    brief,
    reload: () => void load(),
    refresh,
    setDone,
    playBrief,
  };
}
