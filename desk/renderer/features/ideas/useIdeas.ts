// The Ideas window's data (JD-73): GET /ideas, re-loaded on ideas.changed; saves and actions answer
// with the idea, which replaces the listed one at once (the event's reload follows).
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskIdea, IdeaAction, IdeaActionResponse, IdeaProject, IdeasResponse } from "@jarvis/shared";
import { useBridge } from "../../app/bridge";

export interface IdeasData {
  ideas: DeskIdea[];
  projects: IdeaProject[];
  loading: boolean;
  /** Why loading failed, one line. */
  loadError?: string;
  create(text: string, project: string): Promise<DeskIdea>;
  update(id: string, change: { text?: string; project?: string }): Promise<DeskIdea>;
  remove(id: string): Promise<void>;
  act(id: string, action: IdeaAction, context: string): Promise<IdeaActionResponse>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `onLoad` hears every list the server sends, with the ids the previous one had. */
export function useIdeas(onLoad?: (ideas: DeskIdea[], before: Set<string> | undefined) => void): IdeasData {
  const bridge = useBridge();
  const [ideas, setIdeas] = useState<DeskIdea[]>([]);
  const [projects, setProjects] = useState<IdeaProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const listener = useRef(onLoad);
  useEffect(() => {
    listener.current = onLoad;
  }, [onLoad]);

  useEffect(() => {
    let alive = true;
    let before: Set<string> | undefined;
    const load = () =>
      bridge.request<IdeasResponse>("/ideas").then(
        (r) => {
          if (!alive) return;
          listener.current?.(r.ideas, before);
          before = new Set(r.ideas.map((i) => i.id));
          setIdeas(r.ideas);
          setProjects(r.projects);
          setLoadError(undefined);
          setLoading(false);
        },
        (err: unknown) => {
          if (!alive) return;
          setLoadError(`Couldn't load ideas: ${message(err)}`);
          setLoading(false);
        },
      );
    void load();
    const off = bridge.subscribe((e) => {
      if (e.type === "ideas.changed") void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  const upsert = useCallback((idea: DeskIdea) => {
    setIdeas((list) =>
      list.some((i) => i.id === idea.id) ? list.map((i) => (i.id === idea.id ? idea : i)) : [idea, ...list],
    );
    return idea;
  }, []);

  const create = useCallback(
    async (text: string, project: string) =>
      upsert(await bridge.request<DeskIdea>("/ideas", { text, ...(project ? { project } : {}) })),
    [bridge, upsert],
  );

  const update = useCallback(
    async (id: string, change: { text?: string; project?: string }) =>
      upsert(await bridge.request<DeskIdea>(`/ideas/${encodeURIComponent(id)}`, change)),
    [bridge, upsert],
  );

  const remove = useCallback(
    async (id: string) => {
      await bridge.request(`/ideas/${encodeURIComponent(id)}/delete`, {});
      setIdeas((list) => list.filter((i) => i.id !== id));
    },
    [bridge],
  );

  const act = useCallback(
    async (id: string, action: IdeaAction, context: string) => {
      const r = await bridge.request<IdeaActionResponse>(`/ideas/${encodeURIComponent(id)}/${action}`, {
        ...(context.trim() ? { context: context.trim() } : {}),
      });
      upsert(r.idea);
      return r;
    },
    [bridge, upsert],
  );

  return { ideas, projects, loading, loadError, create, update, remove, act };
}
