// The Browser window's tasks (JD-60): GET /browser/tasks once, then browser.task events keep the list
// current; the strip's buttons post to the task's routes (src/desk/routes/browser.ts). A server that
// doesn't have browser tasks (or an error) just leaves the list empty: the box still asks.
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BrowserTask,
  BrowserTaskAnswerRequest,
  BrowserTaskMode,
  BrowserTasksResponse,
  BrowserTaskSummary,
  DeskBridge,
} from "@jarvis/shared";
import { upsertTask } from "./taskModel";

export interface BrowserTasksView {
  tasks: BrowserTaskSummary[];
  /** The last request's error, for the strip to show. */
  error?: string;
  start(text: string, mode: BrowserTaskMode): Promise<boolean>;
  pause(id: string): void;
  resume(id: string): void;
  stop(id: string): void;
  answer(id: string, answer: BrowserTaskAnswerRequest): void;
  log(id: string): Promise<BrowserTask | undefined>;
  /** Deletes a finished task for good (JD-67); false (with `error` set) when the server refused. */
  remove(id: string): Promise<boolean>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** POST /browser/tasks/:id/delete (JD-67): the stored log loses the task; the list left comes back. */
export const deleteBrowserTask = (bridge: DeskBridge, id: string) =>
  bridge.request<BrowserTasksResponse>(`/browser/tasks/${id}/delete`, {});

export function useBrowserTasks(bridge: DeskBridge): BrowserTasksView {
  const [tasks, setTasks] = useState<BrowserTaskSummary[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    const heard = new Set<string>();
    const off = bridge.subscribe((event) => {
      if (event.type !== "browser.task") return;
      heard.add(event.task.id);
      setTasks((list) => upsertTask(list, event.task));
    });
    bridge
      .request<BrowserTasksResponse>("/browser/tasks")
      .then((r) => {
        if (!alive) return;
        // An event that arrived first is newer than the list's copy of that task.
        setTasks((list) => r.tasks.filter((t) => !heard.has(t.id)).reduce(upsertTask, list));
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown> = {}): Promise<BrowserTaskSummary | undefined> => {
      try {
        const task = await bridge.request<BrowserTaskSummary>(path, body);
        setError(undefined);
        if (task?.id) setTasks((list) => upsertTask(list, task));
        return task;
      } catch (err) {
        setError(message(err));
        return undefined;
      }
    },
    [bridge],
  );

  const actions = useMemo(
    () => ({
      start: async (text: string, mode: BrowserTaskMode) => !!(await post("/browser/tasks", { text, mode })),
      pause: (id: string) => void post(`/browser/tasks/${id}/pause`),
      resume: (id: string) => void post(`/browser/tasks/${id}/resume`),
      stop: (id: string) => void post(`/browser/tasks/${id}/stop`),
      answer: (id: string, a: BrowserTaskAnswerRequest) => void post(`/browser/tasks/${id}/answer`, { ...a }),
      log: (id: string) => bridge.request<BrowserTask>(`/browser/tasks/${id}`).catch(() => undefined),
      remove: async (id: string) => {
        try {
          await deleteBrowserTask(bridge, id);
          setError(undefined);
          setTasks((list) => list.filter((t) => t.id !== id));
          return true;
        } catch (err) {
          setError(message(err));
          return false;
        }
      },
    }),
    [bridge, post],
  );

  return { tasks, ...(error ? { error } : {}), ...actions };
}
