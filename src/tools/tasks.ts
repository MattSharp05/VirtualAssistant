// JARVIS Tasks: Matthew's to-do list in Notion (src/tasks.ts). JARVIS adds, completes, lists and edits,
// and accepts or dismisses the to-dos it suggested (src/suggest/).
import type { TaskItem, TaskPriority, TaskView } from "@jarvis/shared";
import { bus } from "../events.js";
import { TasksService, tasksFor } from "../tasks.js";
import { schema, str, type ToolContext, type ToolGroup } from "./types.js";

export const tasks = (ctx: ToolContext): TasksService =>
  tasksFor(ctx.jarvis, () => new TasksService(ctx.config.dataDir, ctx.config.notionToken, ctx.desk?.bus ?? bus));

function line(t: TaskItem): string {
  const bits = [t.due ? `due ${t.due.slice(0, 10)}` : "", t.project ?? "", t.priority ?? "", t.status !== "Open" ? t.status : ""].filter(Boolean);
  const from = t.status === "Suggested" ? ` from ${t.source}${t.why ? `: ${t.why}` : ""}` : "";
  return `- ${t.name}${bits.length ? ` (${bits.join(", ")})` : ""}${from} [id ${t.id}]`;
}

const priority = (v: unknown) => (v ? (String(v).toUpperCase() as TaskPriority) : undefined);
const optional = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));

const group: ToolGroup = {
  name: "tasks",
  promptHint:
    "- Matthew's to-do list is JARVIS Tasks (Notion). When he asks you to remember or remind him to do something without a specific time, add_task (convert days like \"Friday\" to a YYYY-MM-DD due date from today's date). When he says he did something, complete_task. \"What's on my list\" → list_tasks.\n" +
    "- JARVIS also suggests to-dos (status Suggested) from sessions waiting on him, Notion QA, Slack and email: list_tasks when=suggested shows them. \"Add the passport one\" → accept_suggestion; \"add all of them\" → accept_suggestion with task \"all\"; \"drop that one\" → dismiss_suggestion.",
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
      description: "List tasks: today (due today or overdue), upcoming (later or no date), all open, or suggested (to-dos JARVIS proposes); optionally one project.",
      inputSchema: schema({
        when: { type: "string", enum: ["today", "upcoming", "all", "suggested"], description: "Default all" },
        project: str("Only this project (optional)"),
      }),
      handler: async (a, ctx) => {
        const when = String(a.when ?? "all");
        const view: TaskView = when === "today" ? "today" : when === "upcoming" ? "upcoming" : when === "suggested" ? "suggested" : "project";
        const list = await tasks(ctx).list(view, optional(a.project));
        if (!list.length) return when === "today" ? "Nothing due today." : when === "suggested" ? "No suggestions waiting." : "No open tasks.";
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
    {
      name: "accept_suggestion",
      description: 'Accept a suggested to-do (it becomes Open), by id or a unique part of its name; task "all" accepts every suggestion.',
      inputSchema: schema({ task: str('Suggestion id or part of its name, or "all"') }, ["task"]),
      handler: async (a, ctx) => {
        const task = String(a.task ?? "").trim();
        if (task.toLowerCase() === "all") {
          const accepted = await tasks(ctx).acceptAll();
          return accepted.length ? `Added ${accepted.length}:\n${accepted.map(line).join("\n")}` : "No suggestions waiting.";
        }
        return `Added: ${line(await tasks(ctx).accept(task)).slice(2)}`;
      },
    },
    {
      name: "dismiss_suggestion",
      description: "Dismiss a suggested to-do (it won't be suggested again), by id or a unique part of its name.",
      inputSchema: schema({ task: str("Suggestion id or part of its name") }, ["task"]),
      handler: async (a, ctx) => `Dismissed: ${(await tasks(ctx).dismiss(String(a.task ?? ""))).name}`,
    },
  ],
};

export default group;
