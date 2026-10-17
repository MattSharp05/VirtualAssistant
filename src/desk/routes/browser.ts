// Browser tasks for the Desk (JD-60, src/browser/tasks.ts): the Browser window's task box, its History
// menu, and the buttons on a task's question card.
//   GET  /api/desk/browser/tasks                     → BrowserTasksResponse (last 30 days, newest first)
//   GET  /api/desk/browser/tasks/:id                 → BrowserTask (with its log)
//   POST /api/desk/browser/tasks { text, mode? }     → BrowserTaskSummary (asked from the window's box)
//   POST /api/desk/browser/tasks/:id/pause | /resume | /stop      → BrowserTaskSummary
//   POST /api/desk/browser/tasks/:id/answer BrowserTaskAnswerRequest → BrowserTaskSummary
// Every change is also a browser.task event on the live stream.
import type { BrowserTaskAnswerRequest, BrowserTasksResponse } from "@jarvis/shared";
import { browserTasksFor, type BrowserTaskRunner } from "../../browser/tasks.js";
import { JarvisError } from "../../jarvis.js";
import { DeskHttpError, type DeskContext, type DeskRoute } from "./index.js";

const ANSWERS: BrowserTaskAnswerRequest["answer"][] = ["approve", "change", "stop", "reply"];

/** The runner, with its JarvisErrors (one task at a time, no Desk, nothing to answer) as 400s. */
function withRunner<T>(ctx: DeskContext, work: (r: BrowserTaskRunner) => T): T {
  let runner: BrowserTaskRunner;
  try {
    runner = browserTasksFor(ctx.jarvis);
  } catch (err) {
    throw new DeskHttpError(503, (err as Error).message);
  }
  try {
    return work(runner);
  } catch (err) {
    if (err instanceof JarvisError) throw new DeskHttpError(400, err.message);
    throw err;
  }
}

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/browser/tasks",
    handler: ({ ctx }): BrowserTasksResponse => withRunner(ctx, (r) => ({ tasks: r.list() })),
  },
  {
    method: "GET",
    path: "/browser/tasks/:id",
    handler: ({ params, ctx }) =>
      withRunner(ctx, (r) => {
        const task = r.get(params.id);
        if (!task) throw new DeskHttpError(404, "no such browser task");
        return task;
      }),
  },
  {
    method: "POST",
    path: "/browser/tasks",
    handler: ({ body, ctx }) =>
      withRunner(ctx, (r) =>
        r.start({ text: String(body.text ?? ""), origin: "browser", ...(body.mode === "full" ? { mode: "full" as const } : {}) }),
      ),
  },
  { method: "POST", path: "/browser/tasks/:id/pause", handler: ({ params, ctx }) => withRunner(ctx, (r) => r.pause(params.id)) },
  { method: "POST", path: "/browser/tasks/:id/resume", handler: ({ params, ctx }) => withRunner(ctx, (r) => r.resume(params.id)) },
  { method: "POST", path: "/browser/tasks/:id/stop", handler: ({ params, ctx }) => withRunner(ctx, (r) => r.stop(params.id)) },
  {
    method: "POST",
    path: "/browser/tasks/:id/answer",
    handler: ({ params, body, ctx }) => {
      const answer = ANSWERS.find((a) => a === body.answer);
      if (!answer) throw new DeskHttpError(400, `answer must be one of ${ANSWERS.join(", ")}`);
      return withRunner(ctx, (r) =>
        r.answer(params.id, {
          questionId: String(body.questionId ?? ""),
          answer,
          ...(typeof body.text === "string" ? { text: body.text } : {}),
        }),
      );
    },
  },
];

export default routes;
