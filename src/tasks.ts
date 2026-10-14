// JARVIS Tasks: the to-do list, kept in a Notion database Matthew can see and edit (ADR 0006).
// Rows are cached for 60 s; JARVIS's own changes update the cache at once and publish
// `tasks.changed` so Desk windows refresh.

import type { NewTask, TaskItem, TaskPriority, TaskSource, TaskStatus, TaskView } from "@jarvis/shared";
import type { EventBus } from "./events.js";
import { JarvisError } from "./jarvis.js";
import { NotionApi, NotionWriter, normalizeId, notionIdsFile, type Json, type NotionIds } from "./notionWrite.js";

const CACHE_MS = 60_000;

const plain = (rich: unknown) =>
  Array.isArray(rich) ? rich.map((r) => String((r as Json).plain_text ?? ((r as Json).text as Json | undefined)?.content ?? "")).join("") : "";
const selectName = (prop: unknown) => ((prop as Json | undefined)?.select as Json | null | undefined)?.name as string | undefined;

/** A Notion row as a TaskItem. */
export function rowToTask(row: Json): TaskItem {
  const p = (row.properties ?? {}) as Record<string, Json>;
  const due = (p.Due?.date as Json | null | undefined)?.start as string | undefined;
  return {
    id: normalizeId(String(row.id)),
    name: plain(p.Name?.title) || "Untitled",
    status: (selectName(p.Status) as TaskStatus) ?? "Open",
    ...(due ? { due } : {}),
    ...(selectName(p.Project) ? { project: selectName(p.Project) } : {}),
    ...(selectName(p.Priority) ? { priority: selectName(p.Priority) as TaskPriority } : {}),
    source: (selectName(p.Source) as TaskSource) ?? "You",
    ...(p["Source link"]?.url ? { sourceLink: String(p["Source link"].url) } : {}),
    createdAt: String(p.Created?.created_time ?? row.created_time ?? ""),
    ...(row.url ? { url: String(row.url) } : {}),
  };
}

function properties(t: Partial<NewTask> & { status?: TaskStatus; source?: TaskSource }): Json {
  const props: Json = {};
  if (t.name !== undefined) props.Name = { title: [{ type: "text", text: { content: t.name } }] };
  if (t.status) props.Status = { select: { name: t.status } };
  if (t.due !== undefined) props.Due = { date: t.due ? { start: t.due } : null };
  if (t.project !== undefined) props.Project = { select: t.project ? { name: t.project } : null };
  if (t.priority !== undefined) props.Priority = { select: t.priority ? { name: t.priority } : null };
  if (t.source) props.Source = { select: { name: t.source } };
  return props;
}

/** YYYY-MM-DD in the server's time zone (TZ in .env). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DUE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const PRIORITIES: TaskPriority[] = ["P1", "P2", "P3"];

export function viewTasks(all: TaskItem[], view: TaskView, today: string): TaskItem[] {
  const byDue = (a: TaskItem, b: TaskItem) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? "P9").localeCompare(b.priority ?? "P9");
  const open = all.filter((t) => t.status === "Open");
  switch (view) {
    case "today":
      return open.filter((t) => t.due && t.due.slice(0, 10) <= today).sort(byDue);
    case "upcoming":
      return open.filter((t) => !t.due || t.due.slice(0, 10) > today).sort(byDue);
    case "project":
      return [...open].sort((a, b) => (a.project ?? "~").localeCompare(b.project ?? "~") || byDue(a, b));
    case "done":
      return all.filter((t) => t.status === "Done").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case "suggested":
      return all.filter((t) => t.status === "Suggested").sort(byDue);
  }
}

export class TasksService {
  private cache?: { at: number; tasks: TaskItem[] };
  private ids: NotionIds;
  private readonly writer?: NotionWriter;

  constructor(
    private readonly dataDir: string,
    notionToken: string | undefined,
    private readonly bus?: EventBus,
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.ids = notionIdsFile(dataDir).get();
    this.writer = notionToken ? new NotionWriter(new NotionApi(notionToken, fetchImpl), () => this.currentIds()) : undefined;
  }

  /** Re-reads notion.json while setup hasn't run, so running it needs no restart. */
  private currentIds(): NotionIds {
    if (!this.ids.tasksDatabaseId || !this.ids.memoryPageId) this.ids = notionIdsFile(this.dataDir).get();
    return this.ids;
  }

  private db(): { writer: NotionWriter; id: string } {
    if (!this.writer) throw new JarvisError("Notion isn't connected: NOTION_TOKEN is not set in JARVIS's .env.");
    const id = this.currentIds().tasksDatabaseId;
    if (!id) throw new JarvisError("JARVIS Tasks isn't set up yet: run `npm run setup:notion -- --parent <page>` on the server (README → Notion).");
    return { writer: this.writer, id };
  }

  today(): string {
    return localDay(this.now());
  }

  /** Every task except dismissed ones (cached 60 s). */
  async all(fresh = false): Promise<TaskItem[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.tasks;
    const { writer, id } = this.db();
    const rows = await writer.queryRows(id, { filter: { property: "Status", select: { does_not_equal: "Dismissed" } } });
    this.cache = { at: Date.now(), tasks: rows.map(rowToTask) };
    return this.cache.tasks;
  }

  async list(view: TaskView, project?: string): Promise<TaskItem[]> {
    const tasks = viewTasks(await this.all(), view, this.today());
    return project ? tasks.filter((t) => t.project?.toLowerCase() === project.toLowerCase()) : tasks;
  }

  async add(task: NewTask, source: TaskSource = "You"): Promise<TaskItem> {
    const name = task.name?.trim();
    if (!name) throw new JarvisError("A task needs a name.");
    this.check(task);
    const { writer, id } = this.db();
    const row = await writer.createRow(id, properties({ ...task, name, status: "Open", source }));
    const item = rowToTask(row);
    if (!item.createdAt) item.createdAt = this.now().toISOString();
    this.changed((tasks) => [...tasks.filter((t) => t.id !== item.id), item]);
    return item;
  }

  async complete(idOrName: string): Promise<TaskItem> {
    return this.setStatus(await this.find(idOrName), "Done");
  }

  async reopen(idOrName: string): Promise<TaskItem> {
    return this.setStatus(await this.find(idOrName), "Open");
  }

  async update(idOrName: string, change: Partial<NewTask> & { status?: TaskStatus }): Promise<TaskItem> {
    const task = await this.find(idOrName);
    this.check(change);
    const { writer } = this.db();
    const item = rowToTask(await writer.updateRow(task.id, properties(change)));
    this.changed((tasks) => tasks.map((t) => (t.id === item.id ? item : t)));
    return item;
  }

  /** By id, or by a unique (case-insensitive) part of the name among tasks that aren't done. */
  async find(idOrName: string): Promise<TaskItem> {
    const all = await this.all();
    const key = idOrName.trim();
    const byId = all.find((t) => t.id === normalizeId(key));
    if (byId) return byId;
    const q = key.toLowerCase();
    const matches = all.filter((t) => t.status !== "Done" && t.name.toLowerCase().includes(q));
    const exact = matches.filter((t) => t.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0];
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new JarvisError(`No open task matches "${key}".`);
    throw new JarvisError(`"${key}" matches ${matches.length} tasks: ${matches.map((t) => `${t.name} (${t.id})`).join("; ")}. Say which.`);
  }

  private async setStatus(task: TaskItem, status: TaskStatus): Promise<TaskItem> {
    const { writer } = this.db();
    const item = rowToTask(await writer.updateRow(task.id, properties({ status })));
    this.changed((tasks) => tasks.map((t) => (t.id === item.id ? item : t)));
    return item;
  }

  private check(t: Partial<NewTask>): void {
    if (t.due && !DUE.test(t.due)) throw new JarvisError(`Due must be a date like 2026-10-17, not "${t.due}".`);
    if (t.priority && !PRIORITIES.includes(t.priority)) throw new JarvisError(`Priority must be P1, P2 or P3.`);
  }

  private changed(update: (tasks: TaskItem[]) => TaskItem[]): void {
    if (this.cache) this.cache = { at: this.cache.at, tasks: update(this.cache.tasks) };
    this.bus?.publish({ type: "tasks.changed" });
  }
}

/** One TasksService per process (keyed by the JARVIS instance, so tests get their own). */
const services = new WeakMap<object, TasksService>();

export function tasksFor(owner: object, make: () => TasksService): TasksService {
  let s = services.get(owner);
  if (!s) services.set(owner, (s = make()));
  return s;
}

/** Tests (and index.ts) can put a specific instance in place. */
export function useTasksService(owner: object, service: TasksService): void {
  services.set(owner, service);
}
