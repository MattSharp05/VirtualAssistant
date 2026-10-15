// JARVIS Tasks for the To-do window: loads open, done and suggested tasks, re-loads on tasks.changed,
// and makes every change optimistically (the row moves at once, and moves back with an error line
// if the server says no).
import { useCallback, useEffect, useRef, useState } from "react";
import type { AcceptAllResponse, DeskBridge, TaskItem, TasksResponse, TaskStatus } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";

/** What a write does to a task: the route under /tasks/:id and the status it ends in. */
const ACTIONS = {
  done: { status: "Done", failed: "Couldn't mark it done" },
  reopen: { status: "Open", failed: "Couldn't reopen it" },
  accept: { status: "Open", failed: "Couldn't add the suggestion" },
  dismiss: { status: "Dismissed", failed: "Couldn't dismiss the suggestion" },
} satisfies Record<string, { status: TaskStatus; failed: string }>;
export type TaskAction = keyof typeof ACTIONS;

const LOADED_VIEWS = ["project", "done", "suggested"] as const;

/** Every view the window needs; redone if a write finished meanwhile (its answer would be stale). */
async function loadAll(bridge: DeskBridge, writes: { current: number }): Promise<TasksResponse[]> {
  for (;;) {
    const started = writes.current;
    const views = await Promise.all(
      LOADED_VIEWS.map((v) => bridge.request<TasksResponse>(`/tasks?view=${v}`)),
    );
    if (writes.current === started) return views;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface TasksState {
  /** Server rows with pending changes applied. */
  tasks: TaskItem[];
  loading: boolean;
  notionUrl?: string;
  /** The last failure, one line. */
  error?: string;
  /** The last thing that happened elsewhere (sent to JARVIS). */
  note?: string;
  act(task: TaskItem, action: TaskAction): void;
  acceptAll(): void;
  add(name: string): void;
  askJarvis(text: string): void;
}

export function useTasks(): TasksState {
  const bridge = useBridge();
  const [server, setServer] = useState<Map<string, TaskItem>>(new Map());
  const [pending, setPending] = useState<Map<string, TaskItem>>(new Map());
  const [loading, setLoading] = useState(true);
  const [notionUrl, setNotionUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  // Bumped by every finished write: a load that started before one is stale and is redone.
  const writes = useRef(0);
  const tempIds = useRef(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      loadAll(bridge, writes).then(
        (views) => {
          if (!alive) return;
          setServer(new Map(views.flatMap((r) => r.tasks).map((t) => [t.id, t])));
          setNotionUrl(views.find((r) => r.notionUrl)?.notionUrl);
          setLoading(false);
        },
        (err: unknown) => {
          if (!alive) return;
          setError(`Couldn't load tasks: ${message(err)}`);
          setLoading(false);
        },
      );
    void load();
    const off = bridge.subscribe((e) => {
      if (e.type === "tasks.changed") void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  /** Shows `optimistic` at once; on success keeps the server's answer, on failure puts them back. */
  const write = useCallback(
    async (optimistic: TaskItem[], send: () => Promise<TaskItem[]>, failed: string) => {
      setError(undefined);
      setNote(undefined);
      setPending((p) => new Map([...p, ...optimistic.map((t) => [t.id, t] as const)]));
      const drop = () =>
        setPending((p) => {
          const next = new Map(p);
          for (const t of optimistic) if (next.get(t.id) === t) next.delete(t.id);
          return next;
        });
      try {
        const saved = await send();
        writes.current++;
        setServer((s) => new Map([...s, ...saved.map((t) => [t.id, t] as const)]));
        drop();
      } catch (err) {
        writes.current++;
        drop();
        setError(`${failed}: ${message(err)}`);
      }
    },
    [],
  );

  const act = useCallback(
    (task: TaskItem, action: TaskAction) => {
      const { status, failed } = ACTIONS[action];
      void write(
        [{ ...task, status }],
        async () => [await bridge.request<TaskItem>(`/tasks/${encodeURIComponent(task.id)}/${action}`, {})],
        `${failed} (“${task.name}”)`,
      );
    },
    [bridge, write],
  );

  const tasks = [...new Map([...server, ...pending]).values()];

  const acceptAll = useCallback(() => {
    const all = [...new Map([...server, ...pending]).values()].filter((t) => t.status === "Suggested");
    if (!all.length) return;
    void write(
      all.map((t) => ({ ...t, status: "Open" })),
      async () => (await bridge.request<AcceptAllResponse>("/tasks/accept-all", {})).accepted,
      "Couldn't accept the suggestions",
    );
  }, [bridge, write, server, pending]);

  const add = useCallback(
    (name: string) => {
      const temp: TaskItem = {
        id: `adding-${++tempIds.current}`,
        name,
        status: "Open",
        source: "You",
        createdAt: new Date().toISOString(),
      };
      void write(
        [temp],
        async () => {
          const saved = await bridge.request<TaskItem>("/tasks", { name });
          // The placeholder goes with the write; the saved row takes its place.
          setPending((p) => {
            const next = new Map(p);
            next.delete(temp.id);
            return next;
          });
          return [saved];
        },
        `Couldn't add “${name}”`,
      );
    },
    [bridge, write],
  );

  const askJarvis = useCallback(
    (text: string) => {
      setError(undefined);
      bridge.chat(`add ${text}`, "desk-typed").then(
        () => setNote(`Asked JARVIS: “add ${text}”`),
        (err: unknown) => setError(`Couldn't reach JARVIS: ${message(err)}`),
      );
    },
    [bridge],
  );

  return { tasks, loading, notionUrl, error, note, act, acceptAll, add, askJarvis };
}
