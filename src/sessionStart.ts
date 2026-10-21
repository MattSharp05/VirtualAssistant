// Starting a cloud session for a task (JD-69). Paths, first that works:
//   1. "api":     POST /v1/code/sessions with title, repo, environment, tags and the first message
//                 (the worker instructions + the job text) — a normal session in the sidebar.
//   2. "api+cli": the API refused the first-message field: create the session bare, then send the
//                 message with `claude -p --cloud <id>` (the follow-up path, known to work).
//   3. "routine": no login / the API is down: fire the JARVIS Worker routine (Jarvis.startJob does
//                 that, under the 30-an-hour cap). Those sessions are routine runs, titled by the routine.
// What the session is called, where it runs and how it is tagged is decided here too. Each project
// in PROJECTS can bring its own environment, aliases and rules (JD-85); the routine runs only on the
// default repo, so it is never a fallback for another project.

import type { Config, ProjectSetting } from "./config.js";
import { claudeConfigDir, readAccessToken } from "./claudeApi.js";
import { createCloudSession, CreateSessionError, sendToSession, type ApiDeps, type SendResult } from "./cloud.js";
import { loadWorkerInstructions, projectRulesText, sessionPromptText } from "./prompts.js";
import { ticketIdIn, titleFor, writeTitle } from "./sessionTitle.js";

export type StartPath = "api" | "api+cli" | "routine";

/** Where a task's session runs and how it is tagged. */
export interface SessionPlan {
  /** The GitHub URL of the repo, when one is known. */
  repoUrl?: string;
  /** The `project:` tag value. */
  project?: string;
  /** The project's display name ("Drift"), for titles (JD-82) and errors. */
  projectName?: string;
  /** The ticket the task names ("JD-65"). */
  ticket?: string;
  role: "builder" | "task";
  /** env_…: the project's environment, else SESSION_ENVIRONMENT_ID. */
  environmentId?: string;
  /** The project's rules for the first message (base branch, merge policy, extra instructions). */
  rules?: string;
  /** The routine may start it when the API can't: only on the default repo, where the routine runs. */
  routineFallback: boolean;
}

export interface DirectSession {
  sessionId: string;
  url: string;
  title: string;
  tags: string[];
  via: Exclude<StartPath, "routine">;
  repoUrl?: string;
}

/** "owner/name" or a GitHub URL → https://github.com/owner/name. */
export function repoUrlOf(repo: string | undefined): string | undefined {
  const r = repo?.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!r) return undefined;
  if (/^https?:\/\//i.test(r)) return r;
  const m = r.match(/^(?:github\.com\/)?([\w.-]+\/[\w.-]+)$/i);
  return m ? `https://github.com/${m[1]}` : undefined;
}

const ownerName = (url: string | undefined) => url?.match(/github\.com\/([\w.-]+\/[\w.-]+)/i)?.[1].toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A project's names: slug, name and aliases. */
const namesOf = (p: ProjectSetting) => [p.slug, p.name, ...(p.aliases ?? [])];

/** The project the task names: by ticket prefix, "in trip" / "for JARVIS Desk", "a Drift session", or "trip: …". */
function namedProject(task: string, projects: ProjectSetting[], ticket: string | undefined): ProjectSetting | undefined {
  const prefix = ticket?.split("-")[0];
  const byTicket = prefix ? projects.find((p) => p.prefix?.toUpperCase() === prefix) : undefined;
  if (byTicket) return byTicket;
  return projects.find((p) => {
    const names = namesOf(p).map(escape).join("|");
    return new RegExp(
      `\\b(?:in|on|for)\\s+(?:the\\s+)?(?:${names})\\b|\\b(?:a|an|the|new)\\s+(?:new\\s+)?(?:${names})\\s+(?:cloud\\s+)?(?:session|task|job|worker|builder)\\b|^\\s*(?:${names})\\s*:`,
      "i",
    ).test(task);
  });
}

/** The project a slug, name or alias names (any case); undefined when none does. */
export function findProject(name: string, projects: ProjectSetting[] = []): ProjectSetting | undefined {
  const n = name.trim().toLowerCase();
  return n ? projects.find((p) => namesOf(p).some((x) => x.toLowerCase() === n)) : undefined;
}

/** "jarvis (JARVIS Desk), drift (Drift; also driftship, shelfzero)": for the tool description and errors. */
export function describeProjects(projects: ProjectSetting[] = []): string {
  return projects
    .map((p) => {
      const also = (p.aliases ?? []).filter((a) => a.toLowerCase() !== p.slug.toLowerCase());
      return `${p.slug} (${p.name}${also.length ? `; also ${also.join(", ")}` : ""})`;
    })
    .join(", ");
}

/**
 * Repo, project, environment, ticket and role for a task: the project the caller picked (`chosen`,
 * start_session's project argument) wins, then a GitHub URL in the task, then a project the task
 * names (PROJECTS), then DEFAULT_REPO (and the project whose repo it is).
 */
export function planSession(task: string, config: Pick<Config, "projects" | "defaultRepo" | "sessionEnvironmentId">, chosen?: ProjectSetting): SessionPlan {
  const projects = config.projects ?? [];
  const prefixes = projects.map((p) => p.prefix).filter((p): p is string => Boolean(p));
  const ticket = ticketIdIn(task, prefixes) ?? (prefixes.length ? undefined : ticketIdIn(task));
  const inTask = chosen ? undefined : repoUrlOf(task.match(/\bhttps?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i)?.[0]);
  const project =
    chosen ??
    (inTask
      ? projects.find((p) => ownerName(repoUrlOf(p.repo)) === ownerName(inTask))
      : (namedProject(task, projects, ticket) ?? projects.find((p) => p.repo && ownerName(repoUrlOf(p.repo)) === ownerName(repoUrlOf(config.defaultRepo)))));
  const repoUrl = inTask ?? repoUrlOf(project?.repo) ?? repoUrlOf(config.defaultRepo);
  const slug = project?.slug ?? ownerName(repoUrl)?.split("/")[1];
  const environmentId = project?.environment ?? config.sessionEnvironmentId;
  const rules = project ? projectRulesText(project) : undefined;
  return {
    ...(repoUrl ? { repoUrl } : {}),
    ...(slug ? { project: slug } : {}),
    ...(project ? { projectName: project.name } : {}),
    ...(ticket ? { ticket } : {}),
    role: ticket ? "builder" : "task",
    ...(environmentId ? { environmentId } : {}),
    ...(rules ? { rules } : {}),
    routineFallback: !repoUrl || ownerName(repoUrl) === ownerName(repoUrlOf(config.defaultRepo)),
  };
}

/** project:<slug>, role:builder|task, jarvis:<job> (and ticket:<ID>), so the Agents tree and JARVIS find it. */
export function sessionTags(plan: SessionPlan, jobId: string): string[] {
  return [...(plan.project ? [`project:${plan.project}`] : []), `role:${plan.role}`, `jarvis:${jobId}`, ...(plan.ticket ? [`ticket:${plan.ticket}`] : [])];
}

export interface StarterDeps extends ApiDeps {
  /** The worker instructions (docs/routine-prompt.md, read once at startup). */
  instructions?: string;
  /** Writes a title for a task (one cheap worker-model call); undefined = use the first words. */
  writeTitle?: (task: string) => Promise<string | undefined>;
  send?: (claudeBin: string, sessionId: string, message: string) => Promise<SendResult>;
  log?: (line: string) => void;
}

/** HTTP statuses that mean "the request body was refused" (the first-message field), not "no access". */
const BODY_REFUSED = new Set([400, 422]);

export class SessionStarter {
  readonly instructions: string;

  constructor(
    private readonly config: Config,
    private readonly deps: StarterDeps = {},
  ) {
    this.instructions = deps.instructions ?? loadWorkerInstructions();
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }

  /** A title for a task (the rename action uses it too). */
  title(task: string, ticket = planSession(task, this.config).ticket): Promise<string> {
    const write = this.deps.writeTitle ?? ((t: string) => writeTitle(this.config.claudeBin, this.config.workerModel, t, this.config.dataDir));
    return titleFor(task, ticket, write);
  }

  /** The plan for a task, on the project `chosen` when the caller picked one. */
  plan(task: string, chosen?: ProjectSetting): SessionPlan {
    return planSession(task, this.config, chosen);
  }

  /**
   * Paths 1 and 2; throws (CreateSessionError or Error) when neither works, so the caller can fire
   * the routine (when `plan.routineFallback` allows it).
   */
  async start(jobId: string, task: string, sentAt: Date, plan = this.plan(task)): Promise<DirectSession> {
    // No login, no API: fail before spending a title call.
    if (!readAccessToken(this.deps.configDir ?? claudeConfigDir())) throw new CreateSessionError("no claude.ai login found (run: docker compose run --rm jarvis claude auth login)");
    const tags = sessionTags(plan, jobId);
    const title = await this.title(task, plan.ticket);
    const prompt = sessionPromptText(this.instructions, jobId, task, sentAt, plan.rules);
    const base = { title, tags, repoUrl: plan.repoUrl, environmentId: plan.environmentId };
    const api = { fetchImpl: this.deps.fetchImpl, configDir: this.deps.configDir };
    try {
      const s = await createCloudSession({ ...base, prompt }, api);
      this.log(`started ${jobId} via the sessions API: ${s.sessionId} "${title}"`);
      return { ...s, title, tags, via: "api", ...(plan.repoUrl ? { repoUrl: plan.repoUrl } : {}) };
    } catch (err) {
      if (!(err instanceof CreateSessionError && err.status !== undefined && BODY_REFUSED.has(err.status))) throw err;
      this.log(`sessions API refused the first message (${err.message.slice(0, 160)}); creating the session bare and sending it with the CLI`);
    }
    const s = await createCloudSession(base, api);
    const sent = await (this.deps.send ?? sendToSession)(this.config.claudeBin, s.sessionId, prompt);
    if (!sent.ok) {
      throw new Error(`created ${s.url} but couldn't send it the task: ${sent.error ?? "unknown error"}`);
    }
    this.log(`started ${jobId} via the sessions API + CLI message: ${s.sessionId} "${title}"`);
    return { ...s, title, tags, via: "api+cli", ...(plan.repoUrl ? { repoUrl: plan.repoUrl } : {}) };
  }
}
