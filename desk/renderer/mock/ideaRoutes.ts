// Ideas in the mock bridge (JD-73): the Ideas window's reads and writes against an in-memory list,
// like src/desk/routes/ideas.ts does against DATA_DIR/ideas.json. The list starts as the scenario's
// `/ideas` response; writes change it and publish ideas.changed.
import type { DeskIdea, IdeaAction, IdeaActionResponse, IdeasResponse, TaskItem } from "@jarvis/shared";
import type { MockRoute } from "./types";

const STORE = "mock:ideas";

function store(data: Record<string, unknown>): IdeasResponse {
  if (!data[STORE]) {
    const seed = data["/ideas"] as IdeasResponse | undefined;
    data[STORE] = { ideas: [...(seed?.ideas ?? [])], projects: [...(seed?.projects ?? [])] };
  }
  return data[STORE] as IdeasResponse;
}

const firstLine = (text: string) => (text.split("\n").find((l) => l.trim()) ?? "").trim();

/** The ideas routes; with `failActions`, the three actions fail with that message. */
export function ideaRoutes(opts: { failActions?: string } = {}): MockRoute {
  let added = 0;
  let jobs = 40;
  return (path, body, { data, emit }) => {
    if (!path.startsWith("/ideas")) return undefined;
    const s = store(data);
    if (path === "/ideas" && body === undefined)
      return {
        ideas: [...s.ideas].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        projects: s.projects,
      };
    if (body === undefined) return undefined;
    const b = body as { text?: string; project?: string | null; context?: string };
    const changed = () => emit({ type: "ideas.changed" });
    const now = new Date().toISOString();
    if (path === "/ideas") {
      if (!b.text?.trim()) throw new Error("An idea needs some text.");
      const idea: DeskIdea = {
        id: `mock-idea-${++added}`,
        text: b.text,
        ...(b.project ? { project: b.project } : {}),
        createdAt: now,
        updatedAt: now,
        history: [],
      };
      s.ideas.push(idea);
      changed();
      return idea;
    }
    const m = /^\/ideas\/([^/]+)(?:\/(delete|todo|chat|session))?$/.exec(path);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1]);
    const idea = s.ideas.find((i) => i.id === id);
    if (!idea) throw new Error(`No idea ${id}.`);
    const action = m[2];
    if (!action) {
      if (b.text !== undefined) {
        if (!b.text.trim()) throw new Error("An idea needs some text.");
        idea.text = b.text;
      }
      if (b.project !== undefined) {
        if (b.project) idea.project = b.project;
        else delete idea.project;
      }
      idea.updatedAt = now;
      changed();
      return idea;
    }
    if (action === "delete") {
      s.ideas = s.ideas.filter((i) => i.id !== id);
      changed();
      return { ok: true };
    }
    if (opts.failActions) throw new Error(opts.failActions);
    const kind = action as IdeaAction;
    const out: Omit<IdeaActionResponse, "idea"> = {};
    if (kind === "todo") {
      if (idea.history.some((h) => h.kind === "todo")) return { idea };
      const project = s.projects.find((p) => p.slug === idea.project)?.name;
      const task: TaskItem = {
        id: `mock-idea-task-${id}`,
        name: firstLine(idea.text),
        status: "Suggested",
        source: "Idea",
        ...(project ? { project } : {}),
        ...(b.context ? { why: b.context } : {}),
        createdAt: now,
      };
      out.task = task;
      idea.history.push({ kind, at: now });
    } else if (kind === "chat") {
      out.messageId = `mock-idea-chat-${id}`;
      idea.history.push({ kind, at: now });
    } else {
      const name = `j${++jobs}`;
      const url = `https://claude.ai/code/session_01IDEA${jobs}`;
      out.session = { name, url };
      idea.history.push({ kind, at: now, link: url, label: name });
    }
    changed();
    return { idea, ...out } satisfies IdeaActionResponse;
  };
}
