// The ambient face's data (JD-25): the Today digest, the sessions and the plan usage, read on open,
// every minute, and when the server says one changed (today.updated, sessions.changed, tasks.changed).
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeskBridge,
  DeskSession,
  TaskItem,
  TasksResponse,
  TodayResponse,
  UsageResponse,
} from "@jarvis/shared";

export const REFRESH_MS = 60_000;
/** The clock re-reads the time this often (it shows minutes). */
export const TICK_MS = 5_000;

export interface AmbientData {
  today?: TodayResponse;
  sessions?: DeskSession[];
  usage?: UsageResponse;
  /** To-dos due today: the digest's, then GET /tasks?view=today after tasks.changed. */
  tasks?: TaskItem[];
}

/** Each source loads on its own: one failing leaves the others (and its last answer) on screen. */
export function useAmbientData(bridge: DeskBridge): AmbientData {
  const [data, setData] = useState<AmbientData>({});
  const alive = useRef(true);

  const load = useCallback(
    <K extends keyof AmbientData>(key: K, path: string, pick: (r: never) => AmbientData[K]) =>
      bridge.request<never>(path).then(
        (r) => void (alive.current && setData((d) => ({ ...d, [key]: pick(r) }))),
        () => undefined,
      ),
    [bridge],
  );
  const loadToday = useCallback(() => void load("today", "/today", (r: TodayResponse) => r), [load]);
  const loadSessions = useCallback(() => void load("sessions", "/sessions", (r: DeskSession[]) => r), [load]);
  const loadUsage = useCallback(() => void load("usage", "/usage", (r: UsageResponse) => r), [load]);
  const loadTasks = useCallback(
    () => void load("tasks", "/tasks?view=today", (r: TasksResponse) => r.tasks),
    [load],
  );

  useEffect(() => {
    alive.current = true;
    // Once a to-do changed, the digest's list is out of date: read them live from then on.
    let liveTasks = false;
    const all = () => {
      loadToday();
      loadSessions();
      loadUsage();
      if (liveTasks) loadTasks();
    };
    all();
    const every = setInterval(all, REFRESH_MS);
    const off = bridge.subscribe((e) => {
      if (e.type === "today.updated") loadToday();
      if (e.type === "sessions.changed") loadSessions();
      if (e.type === "tasks.changed") {
        liveTasks = true;
        loadTasks();
      }
    });
    return () => {
      alive.current = false;
      clearInterval(every);
      off();
    };
  }, [bridge, loadToday, loadSessions, loadUsage, loadTasks]);

  return data;
}

export interface Clock {
  /** What the face shows (the scenario's time in the preview). */
  now: number;
  /** The real time, for how long ago things happened (the mock's times are relative to it). */
  real: number;
}

/**
 * Now, ticking; the preview's scenario can start the shown clock at a fixed time (ui.now) and it runs
 * on from there.
 */
export function useClock(start?: string): Clock {
  const [offset] = useState(() => (start ? Date.parse(start) - Date.now() : 0));
  const read = useCallback(() => {
    const real = Date.now();
    return { now: real + offset, real };
  }, [offset]);
  const [clock, setClock] = useState(read);
  useEffect(() => {
    const t = setInterval(() => setClock(read()), TICK_MS);
    return () => clearInterval(t);
  }, [read]);
  return clock;
}
