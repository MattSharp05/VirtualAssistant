// The Ideas window (JD-73): Matthew's ideas from JARVIS's own store (src/ideas.ts).
//   GET    /api/desk/ideas                       → IdeasResponse (ideas newest first + projects)
//   POST   /api/desk/ideas { text, project? }    → DeskIdea
//   POST   /api/desk/ideas/:id { text?, project? } (or PUT) → DeskIdea   (project null/"" = Unsorted)
//   DELETE /api/desk/ideas/:id (or POST …/:id/delete) → { ok }
//   POST   /api/desk/ideas/:id/todo    { context? } → IdeaActionResponse: a Suggested to-do (source Idea)
//   POST   /api/desk/ideas/:id/chat    { context? } → IdeaActionResponse: the idea sent to the brain
//   POST   /api/desk/ideas/:id/session { context? } → IdeaActionResponse: a cloud session on its project
// Every change publishes ideas.changed; each action appends to the idea's history.
import type { DeskIdea, IdeaActionResponse, IdeasResponse } from "@jarvis/shared";
import { ideaChatText, IdeaNotFound, ideaProjects, ideaSessionTask, ideasFor, ideaSuggestion, IdeasStore } from "../../ideas.js";
import { JarvisError } from "../../jarvis.js";
import { suggesterFor } from "../../suggest/index.js";
import { tasks } from "../../tools/tasks.js";
import type { ToolContext } from "../../tools/types.js";
import { DeskHttpError, type DeskContext, type DeskRoute } from "./index.js";

export const ideasStore = (ctx: DeskContext): IdeasStore => ideasFor(ctx.jarvis, () => new IdeasStore(ctx.jarvis.config.dataDir, ctx.bus));

const projectsOf = (ctx: DeskContext) => ideaProjects(ctx.jarvis.config.projects, ctx.jarvis.store.recentJobs(1000));

const toolContext = (ctx: DeskContext): ToolContext => ({ jarvis: ctx.jarvis, config: ctx.jarvis.config, desk: ctx });

/** Unknown ids are 404s; other JarvisErrors (empty text, Notion not set up…) are the Desk's to show: 400. */
async function friendly<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof IdeaNotFound) throw new DeskHttpError(404, err.message);
    if (err instanceof JarvisError) throw new DeskHttpError(400, err.message);
    throw err;
  }
}

function find(ctx: DeskContext, id: string): DeskIdea {
  const idea = ideasStore(ctx).get(id);
  if (!idea) throw new DeskHttpError(404, `No idea ${id}.`);
  return idea;
}

const update: DeskRoute["handler"] = ({ params, body, ctx }) =>
  friendly(() => ideasStore(ctx).update(params.id, { text: body.text, project: body.project === null ? "" : body.project }));

const remove: DeskRoute["handler"] = async ({ params, ctx }) => {
  await friendly(() => ideasStore(ctx).remove(params.id));
  return { ok: true };
};

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/ideas",
    handler: ({ ctx }): IdeasResponse => ({ ideas: ideasStore(ctx).list(), projects: projectsOf(ctx) }),
  },
  {
    method: "POST",
    path: "/ideas",
    handler: ({ body, ctx }) =>
      friendly(() => ideasStore(ctx).add({ text: String(body.text ?? ""), ...(typeof body.project === "string" ? { project: body.project } : {}) })),
  },
  { method: "POST", path: "/ideas/:id", handler: update },
  { method: "PUT", path: "/ideas/:id", handler: update },
  { method: "DELETE", path: "/ideas/:id", handler: remove },
  { method: "POST", path: "/ideas/:id/delete", handler: remove },
  {
    method: "POST",
    path: "/ideas/:id/todo",
    handler: ({ params, body, ctx }): Promise<IdeaActionResponse> =>
      friendly(async () => {
        const idea = find(ctx, params.id);
        const suggestion = ideaSuggestion(idea, body.context, projectsOf(ctx));
        if (!suggestion.name) throw new DeskHttpError(400, "The idea is empty.");
        const [made] = await suggesterFor(toolContext(ctx)).add([suggestion]);
        if (!made) {
          // Made from this idea before (the dedupe key): answer with that one, history unchanged.
          const task = (await tasks(toolContext(ctx)).keyed()).get(suggestion.dedupeKey);
          return { idea, ...(task ? { task } : {}) };
        }
        const saved = await ideasStore(ctx).record(idea.id, { kind: "todo", ...(made.url ? { link: made.url } : {}) });
        return { idea: saved, task: made };
      }),
  },
  {
    method: "POST",
    path: "/ideas/:id/chat",
    handler: ({ params, body, ctx }): Promise<IdeaActionResponse> =>
      friendly(async () => {
        const idea = find(ctx, params.id);
        if (!ctx.brain) throw new DeskHttpError(503, "the brain isn't running");
        const { messageId, done } = ctx.brain.start(ideaChatText(idea, body.context, projectsOf(ctx)), "desk-typed");
        // Failures reach the Desk as brain.error on the stream.
        done.catch(() => undefined);
        const saved = await ideasStore(ctx).record(idea.id, { kind: "chat" });
        return { idea: saved, messageId };
      }),
  },
  {
    method: "POST",
    path: "/ideas/:id/session",
    handler: ({ params, body, ctx }): Promise<IdeaActionResponse> =>
      friendly(async () => {
        const idea = find(ctx, params.id);
        const { job } = await ctx.jarvis.startJob(ideaSessionTask(idea, body.context, projectsOf(ctx)));
        ctx.bus.publish({ type: "sessions.changed" });
        const saved = await ideasStore(ctx).record(idea.id, { kind: "session", link: job.url, label: job.id });
        return { idea: saved, session: { name: job.id, url: job.url } };
      }),
  },
];

export default routes;
