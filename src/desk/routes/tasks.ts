// JARVIS Tasks for the Desk's To-do window:
//   GET  /api/desk/tasks?view=today|upcoming|project|done|suggested   → TasksResponse
//   POST /api/desk/tasks { name, due?, project?, priority? }          → TaskItem
//   POST /api/desk/tasks/:id/done | /reopen                          → TaskItem
//   POST /api/desk/tasks/:id/accept (→ Open) | /dismiss (→ Dismissed) → TaskItem (suggestions)
//   POST /api/desk/tasks/accept-all                                  → AcceptAllResponse
// Changes publish tasks.changed on the live stream.
import type { AcceptAllResponse, NewTask, TaskPriority, TasksResponse, TaskView } from "@jarvis/shared";
import { JarvisError } from "../../jarvis.js";
import { TasksService, tasksFor } from "../../tasks.js";
import { DeskHttpError, type DeskContext, type DeskRoute } from "./index.js";

const VIEWS: TaskView[] = ["today", "upcoming", "project", "done", "suggested"];

const service = (ctx: DeskContext): TasksService =>
  tasksFor(ctx.jarvis, () => new TasksService(ctx.jarvis.config.dataDir, ctx.jarvis.config.notionToken, ctx.bus));

/** JarvisErrors (not set up, bad date…) are the Desk's to show: 400 instead of 500. */
async function friendly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof JarvisError) throw new DeskHttpError(400, err.message);
    throw err;
  }
}

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/tasks",
    handler: async ({ url, ctx }): Promise<TasksResponse> => {
      const view = (url.searchParams.get("view") ?? "today") as TaskView;
      if (!VIEWS.includes(view)) throw new DeskHttpError(400, `view must be one of ${VIEWS.join(", ")}`);
      return { view, tasks: await friendly(() => service(ctx).list(view)) };
    },
  },
  {
    method: "POST",
    path: "/tasks",
    handler: ({ body, ctx }) => {
      const task: NewTask = {
        name: String(body.name ?? ""),
        ...(body.due ? { due: String(body.due) } : {}),
        ...(body.project ? { project: String(body.project) } : {}),
        ...(body.priority ? { priority: String(body.priority) as TaskPriority } : {}),
      };
      return friendly(() => service(ctx).add(task));
    },
  },
  { method: "POST", path: "/tasks/:id/done", handler: ({ params, ctx }) => friendly(() => service(ctx).complete(params.id)) },
  { method: "POST", path: "/tasks/:id/reopen", handler: ({ params, ctx }) => friendly(() => service(ctx).reopen(params.id)) },
  { method: "POST", path: "/tasks/:id/accept", handler: ({ params, ctx }) => friendly(() => service(ctx).accept(params.id)) },
  { method: "POST", path: "/tasks/:id/dismiss", handler: ({ params, ctx }) => friendly(() => service(ctx).dismiss(params.id)) },
  {
    method: "POST",
    path: "/tasks/accept-all",
    handler: async ({ ctx }): Promise<AcceptAllResponse> => ({ accepted: await friendly(() => service(ctx).acceptAll()) }),
  },
];

export default routes;
