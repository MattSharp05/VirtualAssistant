// Ideas (JD-73): Matthew's quick notes, each tagged to a project (or Unsorted), kept in JARVIS's own
// store (DATA_DIR/ideas.json) — not Notion, which JARVIS only writes for Memory and Tasks. Every change
// publishes `ideas.changed`. An idea can be turned into a Suggested to-do (the suggestion path in
// src/suggest/, source "Idea", dedupe key idea:<id>), a chat with JARVIS, or a cloud session on its
// project's repo; each appends to the idea's history and the idea stays in the list.

import { randomUUID } from "node:crypto";
import type { DeskIdea, IdeaHistoryEntry, IdeaProject, NewIdea } from "@jarvis/shared";
import type { ProjectSetting } from "./config.js";
import type { EventBus } from "./events.js";
import { JarvisError } from "./jarvis.js";
import { JsonFile } from "./storage.js";
import type { Job } from "./store.js";
import type { NewSuggestion } from "./tasks.js";

/** Long enough for a page of notes; the window is for ideas, not documents. */
export const MAX_IDEA_CHARS = 10_000;
const MAX_CONTEXT_CHARS = 1_000;

/** The idea's first non-empty line: its title in lists and its to-do's name. */
export function ideaTitle(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim();
}

/** Projects to tag ideas with: PROJECTS in order, then project: tags on sessions JARVIS started. */
export function ideaProjects(projects: ProjectSetting[] | undefined, jobs: Job[]): IdeaProject[] {
  const out: IdeaProject[] = (projects ?? []).map((p) => ({ slug: p.slug, name: p.name }));
  const seen = new Set(out.map((p) => p.slug.toLowerCase()));
  for (const job of jobs) {
    for (const tag of job.tags ?? []) {
      const slug = /^project:(.+)$/.exec(tag)?.[1]?.trim();
      if (slug && !seen.has(slug.toLowerCase())) {
        seen.add(slug.toLowerCase());
        out.push({ slug, name: slug });
      }
    }
  }
  return out;
}

const projectName = (slug: string | undefined, projects: IdeaProject[]) =>
  slug ? (projects.find((p) => p.slug.toLowerCase() === slug.toLowerCase())?.name ?? slug) : undefined;

const cleanContext = (context: unknown) => (typeof context === "string" ? context.trim().slice(0, MAX_CONTEXT_CHARS) : "");

/** Add to to-dos: a Suggested task named after the idea, why = the context (if any). */
export function ideaSuggestion(idea: DeskIdea, context: unknown, projects: IdeaProject[]): NewSuggestion {
  const project = projectName(idea.project, projects);
  return {
    name: ideaTitle(idea.text).slice(0, 200),
    source: "Idea",
    dedupeKey: `idea:${idea.id}`,
    why: cleanContext(context),
    ...(project ? { project } : {}),
  };
}

/** Chat with JARVIS: the idea, and what Matthew wants to work out. */
export function ideaChatText(idea: DeskIdea, context: unknown, projects: IdeaProject[]): string {
  const project = projectName(idea.project, projects);
  const extra = cleanContext(context);
  return [`An idea of mine${project ? ` for ${project}` : ""}:`, idea.text.trim(), ...(extra ? [extra] : [])].join("\n\n");
}

/**
 * Start a session: the task text. It opens with "<project>:" so src/sessionStart.ts's planSession puts
 * the session on that project's repo and tags it project:<slug>; Unsorted ideas get DEFAULT_REPO.
 */
export function ideaSessionTask(idea: DeskIdea, context: unknown, projects: IdeaProject[]): string {
  const project = idea.project ? (projects.find((p) => p.slug.toLowerCase() === idea.project!.toLowerCase())?.slug ?? idea.project) : undefined;
  const extra = cleanContext(context);
  return [`${project ? `${project}: ` : ""}${idea.text.trim()}`, ...(extra ? [extra] : [])].join("\n\n");
}

interface IdeasFile {
  ideas: DeskIdea[];
}

export class IdeasStore {
  private readonly file: JsonFile<IdeasFile>;

  constructor(
    dataDir: string,
    private readonly bus?: EventBus,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => randomUUID().slice(0, 8),
  ) {
    this.file = new JsonFile<IdeasFile>(dataDir, "ideas", { ideas: [] });
  }

  /** Every idea, newest first. */
  list(): DeskIdea[] {
    return [...this.file.get().ideas].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): DeskIdea | undefined {
    return this.file.get().ideas.find((i) => i.id === id);
  }

  async add(input: NewIdea): Promise<DeskIdea> {
    const text = checkText(input.text);
    const at = this.now().toISOString();
    let id = this.newId();
    while (this.get(id)) id = this.newId();
    const project = cleanProject(input.project);
    const idea: DeskIdea = { id, text, ...(project ? { project } : {}), createdAt: at, updatedAt: at, history: [] };
    await this.save((ideas) => [...ideas, idea]);
    return idea;
  }

  /** Text and/or project; project null or "" = Unsorted. */
  async update(id: string, change: { text?: unknown; project?: unknown }): Promise<DeskIdea> {
    const current = this.must(id);
    const next: DeskIdea = { ...current, updatedAt: this.now().toISOString() };
    if (change.text !== undefined) next.text = checkText(change.text);
    if (change.project !== undefined) {
      const project = cleanProject(change.project);
      if (project) next.project = project;
      else delete next.project;
    }
    await this.save((ideas) => ideas.map((i) => (i.id === id ? next : i)));
    return next;
  }

  async remove(id: string): Promise<void> {
    this.must(id);
    await this.save((ideas) => ideas.filter((i) => i.id !== id));
  }

  /** Appends what was done with the idea (at = now). */
  async record(id: string, entry: Omit<IdeaHistoryEntry, "at">): Promise<DeskIdea> {
    const current = this.must(id);
    const next: DeskIdea = { ...current, history: [...current.history, { ...entry, at: this.now().toISOString() }] };
    await this.save((ideas) => ideas.map((i) => (i.id === id ? next : i)));
    return next;
  }

  private must(id: string): DeskIdea {
    const idea = this.get(id);
    if (!idea) throw new IdeaNotFound(id);
    return idea;
  }

  private async save(change: (ideas: DeskIdea[]) => DeskIdea[]): Promise<void> {
    await this.file.update((f) => ({ ideas: change(f.ideas) }));
    this.bus?.publish({ type: "ideas.changed" });
  }
}

export class IdeaNotFound extends JarvisError {
  constructor(id: string) {
    super(`No idea ${id}.`);
  }
}

function checkText(text: unknown): string {
  const t = typeof text === "string" ? text.replace(/\s+$/, "") : "";
  if (!t.trim()) throw new JarvisError("An idea needs some text.");
  if (t.length > MAX_IDEA_CHARS) throw new JarvisError(`Ideas can be up to ${MAX_IDEA_CHARS} characters.`);
  return t;
}

function cleanProject(project: unknown): string | undefined {
  return typeof project === "string" && project.trim() ? project.trim().slice(0, 80) : undefined;
}

/** One store per process (keyed by the JARVIS instance, so tests get their own). */
const stores = new WeakMap<object, IdeasStore>();

export function ideasFor(owner: object, make: () => IdeasStore): IdeasStore {
  let s = stores.get(owner);
  if (!s) stores.set(owner, (s = make()));
  return s;
}
