// Cloud sessions: status, history, messaging, starting new ones.
import { describeProjects } from "../sessionStart.js";
import { CoreTools } from "./core.js";
import { int, schema, str, type ToolContext, type ToolGroup } from "./types.js";

const cores = new WeakMap<ToolContext, CoreTools>();
export const core = (ctx: ToolContext): CoreTools => {
  let c = cores.get(ctx);
  if (!c) cores.set(ctx, (c = new CoreTools(ctx.jarvis, ctx.config.notionToken)));
  return c;
};

const group: ToolGroup = {
  name: "sessions",
  promptHint: [
    "- Use your tools; never guess a session's state. \"What's X doing / how's X going\" → overview, then session_activity for that session.",
    "- When Matthew asks you to tell a session something, send it with send_to_session (clear, self-contained, in his voice), then confirm in one line what you sent. Its answer arrives later as a report.",
    "- You may start new cloud sessions with start_session when he asks for work to be done.",
    "- start_session on an unlisted project fails with \"Unknown project\". If Matthew wants to work on a new project, offer add_project (repo and an optional ticket prefix are usually enough; no environment needed unless he says the project needs its own).",
  ].join("\n"),
  tools: [
    {
      name: "overview",
      description:
        "Current state: Claude login, plan usage (5-hour and weekly), routine fires, the sessions JARVIS tracks (name, kind, link) and their latest reports. Start here for any status question.",
      inputSchema: schema({}),
      handler: (_a, ctx) => core(ctx).overview(),
    },
    {
      name: "list_cloud_sessions",
      description: "All of Matthew's active Claude Code cloud sessions (title, status, last activity, id), newest first.",
      inputSchema: schema({}),
      handler: (_a, ctx) => core(ctx).sessions(),
    },
    {
      name: "session_activity",
      description:
        "What a session has been doing lately: its recent messages and tool use, read from the session's history. target = a tracked name (e.g. mk, j3) or a session id (cse_…/session_…). Use it for 'what is X doing'.",
      inputSchema: schema(
        { target: str("Tracked name or session id"), limit: int("How many recent items (default 15)") },
        ["target"],
      ),
      handler: (a, ctx) => core(ctx).activity(String(a.target ?? ""), Number(a.limit ?? 15)),
    },
    {
      name: "send_to_session",
      description:
        "Send Matthew's instruction to a cloud session (an orchestrator or builder). target = tracked name or session id. Write the message as Matthew would, clear and self-contained. The session answers via a report later.",
      inputSchema: schema(
        { target: str("Tracked name or session id"), message: str("The instruction to send") },
        ["target", "message"],
      ),
      handler: (a, ctx) => core(ctx).send(String(a.target ?? ""), String(a.message ?? "")),
    },
    {
      name: "start_session",
      description: (ctx) => {
        const projects = describeProjects(ctx.config.projects);
        return (
          "Start a new cloud session on a task: a normal Claude Code session with a short title, on the default repo or the project the task names (\"in trip\", a ticket ID). Uses plan usage." +
          (projects ? ` Set project (slug or alias) when Matthew names one; it wins over the task text. Projects: ${projects}.` : "") +
          " Set model only when Matthew asks for one. Repeat the confirmation's Environment/Model line to Matthew as given."
        );
      },
      inputSchema: schema(
        {
          task: str("The task, written as a complete instruction"),
          project: str("Optional: the project's slug or alias (see the description); default = from the task"),
          model: str("Optional: opus, sonnet, haiku or a full model id; default = the project's model, else SESSION_MODEL (Opus)"),
        },
        ["task"],
      ),
      handler: (a, ctx) =>
        core(ctx).start(String(a.task ?? ""), typeof a.project === "string" ? a.project : undefined, typeof a.model === "string" ? a.model : undefined),
    },
    {
      name: "list_projects",
      description: "The projects JARVIS knows about and can route sessions to (slug, name, aliases).",
      inputSchema: schema({}),
      handler: (_a, ctx) => core(ctx).listProjects(),
    },
    {
      name: "add_project",
      description:
        "Add a project JARVIS can route sessions to, so Matthew can say \"in <name>\" or name it in a task, without editing PROJECTS or restarting. " +
        "Most projects don't need their own cloud environment: leave `environment` unset and it shares the default one (the one SESSION_ENVIRONMENT_ID " +
        "points to, or JARVIS's own). Only set `environment` when this project genuinely needs different network access, secrets or a setup script, " +
        "and Matthew has already made that environment at claude.ai/code — JARVIS can't create one.",
      inputSchema: schema(
        {
          slug: str("Short lowercase id, e.g. \"trip\" (the project: tag and the word that routes to it)"),
          name: str("Display name, e.g. \"Trip planner\"; default = slug"),
          repo: str("GitHub repo, \"owner/name\" or a URL; default = the account's default repo"),
          aliases: str("Other names that also pick it, comma-separated, e.g. \"tripper, holiday\""),
          prefix: str("Ticket ID prefix, e.g. \"TP\", so tasks naming a ticket pick this project"),
          environment: str("Optional, rare: an existing cloud environment's env_… id. Default = the shared environment."),
          model: str("Optional: opus, sonnet, haiku or a full model id; default = SESSION_MODEL (Opus)"),
          baseBranch: str("Optional: the branch its PRs target"),
          mergePolicy: str("\"never\" (sessions open a PR, never merge) or \"orchestrator\" (default: an orchestrator merges)"),
          extraInstructions: str("Optional: short rules added to the first message of its sessions"),
        },
        ["slug"],
      ),
      handler: (a, ctx) => core(ctx).addProject(a),
    },
    {
      name: "remove_project",
      description: "Remove a project added with add_project. A project from PROJECTS (.env) can't be removed this way.",
      inputSchema: schema({ slug: str("The project's slug") }, ["slug"]),
      handler: (a, ctx) => core(ctx).removeProject(String(a.slug ?? "")),
    },
    {
      name: "rename_jarvis_sessions",
      description:
        "One-off: give the older sessions JARVIS started through the routine (all titled \"Jarvis Worker\") a title from their task. Only when Matthew asks.",
      inputSchema: schema({}),
      handler: (_a, ctx) => core(ctx).renameRoutineSessions(),
    },
  ],
};

export default group;
