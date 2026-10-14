// The worker's structured-output tools: one submit_* per background job (src/jobs/*), registered
// here so the MCP server serves them. Only the worker brain is allowed to call them; the chat brain
// has them disallowed.
import { discoverJobs, jobRunnerFor } from "../jobs/index.js";
import type { ToolGroup } from "./types.js";

const jobs = await discoverJobs();

const group: ToolGroup = {
  name: "submit",
  tools: jobs.map((job) => ({
    ...job.submitTool,
    handler: async (args, ctx) => jobRunnerFor(ctx.jarvis).submit(job.name, args),
  })),
  cli: { disallowedTools: jobs.map((j) => `mcp__jarvis__${j.submitTool.name}`) },
};

export default group;
