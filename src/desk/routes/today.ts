// The Today digest for the Desk's Today window:
//   GET  /api/desk/today          → { digest?, ageSeconds?, running, lastError? }
//   POST /api/desk/today/refresh  → { started: true } (the result arrives as today.updated)
import type { Digest, TodayResponse } from "@jarvis/shared";
import { jobRunnerFor } from "../../jobs/index.js";
import type { DeskRoute } from "./index.js";

const routes: DeskRoute[] = [
  {
    method: "GET",
    path: "/today",
    handler: ({ ctx }): TodayResponse => {
      const runner = jobRunnerFor(ctx.jarvis);
      const result = runner.result<Digest>("digest");
      const lastError = runner.lastError("digest") || undefined;
      return {
        ...(result ? { digest: result.data, ageSeconds: Math.round((Date.now() - Date.parse(result.at)) / 1000) } : {}),
        running: runner.isRunning("digest"),
        ...(lastError ? { lastError } : {}),
      };
    },
  },
  {
    method: "POST",
    path: "/today/refresh",
    handler: ({ ctx }) => {
      void jobRunnerFor(ctx.jarvis).run("digest");
      return { started: true };
    },
  },
];

export default routes;
