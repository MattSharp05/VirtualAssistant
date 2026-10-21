// JARVIS Tasks for the Desk's To-do window:
//   GET  /api/desk/tasks?view=today|upcoming|project|done|suggested   → TasksResponse (+ notionUrl)
//   POST /api/desk/tasks { name, due?, project?, priority? }          → TaskItem
//   POST /api/desk/tasks/:id/done | /reopen                          → TaskItem
//   POST /api/desk/tasks/:id/accept (→ Open) | /dismiss (→ Dismissed) → TaskItem (suggestions)
//   POST /api/desk/tasks/accept-all                                  → AcceptAllResponse
//   POST /api/desk/tasks/:id/chat    { context? } → TaskActionResponse: the task sent to the brain
//   POST /api/desk/tasks/:id/session { context? } → TaskActionResponse: a cloud session on its project
//   GET  /api/desk/tasks/:id/qa                   → TaskQaResponse: a Notion QA ticket's checklist (read-only)
// Changes publish tasks.changed on the live stream.
import type { AcceptAllResponse, NewTask, TaskActionResponse, TaskPriority, TaskQaResponse, TasksResponse, TaskView } from "@jarvis/shared";
import { JarvisError } from "../../jarvis.js";
import { taskChatText, taskSessionText, TasksService, tasksFor } from "../../tasks.js";
import { DeskHttpError, type DeskContext, type DeskRoute } from "./index.js";
import { notionDeskFor, notionFriendly } from "./notion.js";

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
      const tasks = await friendly(() => service(ctx).list(view));
      const notionUrl = service(ctx).databaseUrl();
      return { view, tasks, ...(notionUrl ? { notionUrl } : {}) };
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
  {
    method: "POST",
    path: "/tasks/:id/chat",
    handler: ({ params, body, ctx }): Promise<TaskActionResponse> =>
      friendly(async () => {
        const task = await service(ctx).find(params.id);
        if (!ctx.brain) throw new DeskHttpError(503, "the brain isn't running");
        const { messageId, done } = ctx.brain.start(taskChatText(task, body.context), "desk-typed");
        // Failures reach the Desk as brain.error on the stream.
        done.catch(() => undefined);
        const saved = await service(ctx).recordHistory(task.id, { kind: "chat" });
        return { task: saved, messageId };
      }),
  },
  {
    method: "POST",
    path: "/tasks/:id/session",
    handler: ({ params, body, ctx }): Promise<TaskActionResponse> =>
      friendly(async () => {
        const task = await service(ctx).find(params.id);
        const { job } = await ctx.jarvis.startJob(taskSessionText(task, body.context));
        ctx.bus.publish({ type: "sessions.changed" });
        const saved = await service(ctx).recordHistory(task.id, { kind: "session", link: job.url, label: job.id });
        return { task: saved, session: { name: job.id, url: job.url } };
      }),
  },
  {
    method: "GET",
    path: "/tasks/:id/qa",
    handler: async ({ params, ctx }): Promise<TaskQaResponse> => {
      const task = await friendly(() => service(ctx).find(params.id));
      if (task.source !== "Notion QA" || !task.sourceLink) throw new DeskHttpError(400, "This task has no Notion QA page.");
      return { checklist: await notionFriendly(() => notionDeskFor(ctx).qaChecklist(task.sourceLink!)) };
    },
  },
];

export default routes;
