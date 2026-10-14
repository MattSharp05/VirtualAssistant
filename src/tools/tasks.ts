// JARVIS Tasks: Matthew's to-do list in Notion (src/tasks.ts). JARVIS adds, completes, lists and edits.
import type { TaskItem, TaskPriority, TaskView } from "@jarvis/shared";
import { bus } from "../events.js";
import { TasksService, tasksFor } from "../tasks.js";
import { schema, str, type ToolContext, type ToolGroup } from "./types.js";

export const tasks = (ctx: ToolContext): TasksService =>
  tasksFor(ctx.jarvis, () => new TasksService(ctx.config.dataDir, ctx.config.notionToken, ctx.desk?.bus ?? bus));

function line(t: TaskItem): string {
  const bits = [t.due ? `due ${t.due.slice(0, 10)}` : "", t.project ?? "", t.priority ?? "", t.status !== "Open" ? t.status : ""].filter(Boolean);
  return `- ${t.name}${bits.length ? ` (${bits.join(", ")})` : ""} [id ${t.id}]`;
}

const priority = (v: unknown) => (v ? (String(v).toUpperCase() as TaskPriority) : undefined);
const optional = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));

const group: ToolGroup = {
  name: "tasks",
  promptHint:
    "- Matthew's to-do list is JARVIS Tasks (Notion). When he asks you to remember or remind him to do something without a specific time, add_task (convert days like \"Friday\" to a YYYY-MM-DD due date from today's date). When he says he did something, complete_task. \"What's on my list\" → list_tasks.",
  tools: [
    {
      name: "add_task",
      description: "Add a to-do to JARVIS Tasks (status Open, source You).",
      inputSchema: schema(
        {
          name: str("What to do, short, starting with a verb (e.g. 'Renew passport')"),
          due: str("Due date YYYY-MM-DD (optional)"),
          project: str("Project name (optional)"),
          priority: { type: "string", enum: ["P1", "P2", "P3"], description: "Optional priority" },
        },
        ["name"],
      ),
      handler: async (a, ctx) => {
        const t = await tasks(ctx).add({ name: String(a.name ?? ""), due: optional(a.due), project: optional(a.project), priority: priority(a.priority) });
        return `Added: ${line(t).slice(2)}`;
      },
    },
    {
      name: "complete_task",
      description: "Mark a task done, by id (from list_tasks) or by a unique part of its name.",
      inputSchema: schema({ task: str("Task id or part of its name") }, ["task"]),
      handler: async (a, ctx) => `Done: ${(await tasks(ctx).complete(String(a.task ?? ""))).name}`,
    },
    {
      name: "list_tasks",
      description: "List tasks: today (due today or overdue), upcoming (later or no date) or all open; optionally one project.",
      inputSchema: schema({
        when: { type: "string", enum: ["today", "upcoming", "all"], description: "Default all" },
        project: str("Only this project (optional)"),
      }),
      handler: async (a, ctx) => {
        const when = String(a.when ?? "all");
        const view: TaskView = when === "today" ? "today" : when === "upcoming" ? "upcoming" : "project";
        const list = await tasks(ctx).list(view, optional(a.project));
        if (!list.length) return when === "today" ? "Nothing due today." : "No open tasks.";
        return `${list.length} task${list.length === 1 ? "" : "s"} (today is ${tasks(ctx).today()}):\n${list.map(line).join("\n")}`;
      },
    },
    {
      name: "update_task",
      description: "Change a task's name, due date, project, priority or status (Open, Done, Dismissed). Empty string clears a field.",
      inputSchema: schema(
        {
          task: str("Task id or part of its name"),
          name: str("New name"),
          due: str("New due date YYYY-MM-DD, or empty to clear"),
          project: str("New project, or empty to clear"),
          priority: str("P1, P2, P3, or empty to clear"),
          status: { type: "string", enum: ["Open", "Done", "Dismissed"] },
        },
        ["task"],
      ),
      handler: async (a, ctx) => {
        const change = {
          ...(a.name !== undefined ? { name: String(a.name) } : {}),
          ...(a.due !== undefined ? { due: String(a.due) } : {}),
          ...(a.project !== undefined ? { project: String(a.project) } : {}),
          ...(a.priority !== undefined ? { priority: (String(a.priority).toUpperCase() || "") as TaskPriority } : {}),
          ...(a.status !== undefined ? { status: String(a.status) as "Open" | "Done" | "Dismissed" } : {}),
        };
        return `Updated: ${line(await tasks(ctx).update(String(a.task ?? ""), change)).slice(2)}`;
      },
    },
  ],
};

export default group;
