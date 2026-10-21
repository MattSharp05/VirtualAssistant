export interface Config {
  /** Unset = no Telegram; the dashboard alone works. */
  telegramBotToken: string | undefined;
  /** Only this Telegram chat may use the bot. Unset = setup mode: the bot just tells you your chat ID. */
  allowedChatId: number | undefined;
  /** The routine that starts new cloud sessions (claude.ai/code/routines, API trigger). */
  routineId: string | undefined;
  routineToken: string | undefined;
  /** The repo new sessions run on unless the task names a project (DEFAULT_REPO, a GitHub URL or owner/name; JD-69). */
  defaultRepo?: string;
  /** The cloud environment new sessions run in (SESSION_ENVIRONMENT_ID, env_…). Unset = the API's default. */
  sessionEnvironmentId?: string;
  /** The model new sessions run on (SESSION_MODEL, default claude-opus-5-5; JD-86). A project's `model` overrides it. */
  sessionModel?: string;
  /** The cheap model for background calls such as session titles (WORKER_MODEL; default: the haiku in BRAIN_MODELS). */
  workerModel?: string;
  dataDir: string;
  claudeBin: string;
  dashboardPort: number;
  /** When set, the dashboard asks for it (HTTP basic auth, any username). */
  dashboardPassword: string | undefined;
  /** Shared secret cloud sessions send with reports to POST /api/reports. Unset = endpoint off. */
  reportSecret: string | undefined;
  /** Port of the reports-only server (the one Tailscale Funnel exposes). Runs when reportSecret is set. */
  reportsPort: number;
  /** Notion internal integration token (read-only use). Unset = the brain has no Notion. */
  notionToken: string | undefined;
  /** Models the brain may use (first = default unless BRAIN_MODEL is set). */
  brainModels: string[];
  brainModel: string;
  /** Keep one streaming CLI process for the conversation (BRAIN_WARM, default on; 0 = one process per message). */
  brainWarm: boolean;
  /** Matthew's time zone (TZ, default Europe/London): reminders, "today", the brain's clock. */
  timeZone?: string;
  /** claude.ai connectors the brain may read (see CONNECTORS in src/tools/connectors.ts). Empty = none. */
  brainConnectors: string[];
  /** Projects the agent graph always shows (PROJECTS, JSON; JD-57), even with nothing running. */
  projects?: ProjectSetting[];
  /** Read-only GitHub token for PR check runs (GITHUB_TOKEN; public repos work without it, rate-limited). Never logged. */
  githubToken?: string;
}

/** New sessions run on Opus unless SESSION_MODEL, a project or the start_session call says otherwise (JD-86). */
export const DEFAULT_SESSION_MODEL = "claude-opus-5-5";

/** One project in PROJECTS: its tag slug, name, Tickets data source, repo and how its sessions run (JD-85). */
export interface ProjectSetting {
  /** The `project:` tag value (the project's CLAUDE.md `Project slug:`). */
  slug: string;
  name: string;
  /** The Tickets data source (collection://… or its id) or database id, read for in-flight tickets. */
  tickets?: string;
  /** owner/name, for PR numbers the run page gives without a URL. */
  repo?: string;
  /** Ticket ID prefix (e.g. "JD"), for sessions titled `JD-12: …` when the ticket isn't in flight. */
  prefix?: string;
  notionUrl?: string;
  /** The cloud environment (env_…) its sessions run in; overrides SESSION_ENVIRONMENT_ID. */
  environment?: string;
  /** The model its sessions run on; overrides SESSION_MODEL (JD-86). */
  model?: string;
  /** Other names for it ("driftship", "shelfzero"), matched like the slug, in any case. */
  aliases?: string[];
  /** The branch its PRs target (told to the session). */
  baseBranch?: string;
  /** "never": sessions open a PR and never merge. "orchestrator" (default): an orchestrator merges. */
  mergePolicy?: "never" | "orchestrator";
  /** Short project rules added to the first message of its sessions. */
  extraInstructions?: string;
}

/** PROJECTS='[{"slug":"jarvis","name":"JARVIS Desk","tickets":"collection://…","repo":"MattSharp05/VirtualAssistant","prefix":"JD"}]' */
export function parseProjects(text: string | undefined): ProjectSetting[] {
  if (!text) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error("PROJECTS must be a JSON list, e.g. [{\"slug\":\"jarvis\",\"name\":\"JARVIS Desk\"}]");
  }
  if (!Array.isArray(rows)) throw new Error("PROJECTS must be a JSON list of projects");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return rows.map((r: Record<string, unknown>, i) => {
    const slug = str(r?.slug);
    if (!slug) throw new Error(`PROJECTS[${i}] needs a slug`);
    const out: ProjectSetting = { slug, name: str(r.name) ?? slug };
    for (const key of ["tickets", "repo", "prefix", "notionUrl", "environment", "model", "baseBranch", "extraInstructions"] as const) if (str(r[key])) out[key] = str(r[key]);
    const aliases = Array.isArray(r.aliases) ? r.aliases.map(str).filter((a): a is string => Boolean(a)) : [];
    if (aliases.length) out.aliases = aliases;
    const policy = str(r.mergePolicy) as ProjectSetting["mergePolicy"] | undefined;
    if (policy && policy !== "never" && policy !== "orchestrator") throw new Error(`PROJECTS[${i}].mergePolicy must be "never" or "orchestrator"`);
    if (policy) out.mergePolicy = policy;
    return out;
  });
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(): Config {
  const chatId = optional("TELEGRAM_ALLOWED_CHAT_ID");
  if (chatId !== undefined && !/^-?\d+$/.test(chatId)) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_ID must be a number (send /start to the bot to get yours)");
  }
  const port = Number(optional("DASHBOARD_PORT") ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error("DASHBOARD_PORT must be a port number");
  const reportsPort = Number(optional("REPORTS_PORT") ?? 8081);
  if (!Number.isInteger(reportsPort) || reportsPort <= 0) throw new Error("REPORTS_PORT must be a port number");
  const reportSecret = optional("REPORT_SECRET");
  if (reportSecret !== undefined && reportSecret.length < 24) {
    throw new Error("REPORT_SECRET is too short; generate one with: openssl rand -hex 32");
  }
  // Full model ids on purpose: an alias can quietly resolve to an older model.
  const brainModels = (optional("BRAIN_MODELS") ?? "claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const brainModel = optional("BRAIN_MODEL") ?? brainModels[0];
  if (!brainModels.includes(brainModel)) brainModels.push(brainModel);
  // Node reads TZ for local dates; setting it here makes "today" and reminder times Matthew's.
  const timeZone = optional("TZ") ?? "Europe/London";
  process.env.TZ = timeZone;
  const connectors = optional("BRAIN_CONNECTORS") ?? "Google Calendar,Gmail,Slack";
  const brainConnectors = /^none$/i.test(connectors) ? [] : connectors.split(",").map((c) => c.trim()).filter(Boolean);
  return {
    brainConnectors,
    projects: parseProjects(optional("PROJECTS")),
    githubToken: optional("GITHUB_TOKEN"),
    notionToken: optional("NOTION_TOKEN"),
    brainModels,
    brainModel,
    timeZone,
    brainWarm: !/^(0|false|off|no)$/i.test(optional("BRAIN_WARM") ?? "1"),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
    allowedChatId: chatId === undefined ? undefined : Number(chatId),
    routineId: optional("ROUTINE_ID"),
    routineToken: optional("ROUTINE_TOKEN"),
    defaultRepo: optional("DEFAULT_REPO"),
    sessionEnvironmentId: optional("SESSION_ENVIRONMENT_ID"),
    sessionModel: optional("SESSION_MODEL") ?? DEFAULT_SESSION_MODEL,
    workerModel: optional("WORKER_MODEL") ?? brainModels.find((m) => m.includes("haiku")),
    dataDir: optional("DATA_DIR") ?? "./data",
    claudeBin: optional("CLAUDE_BIN") ?? "claude",
    dashboardPort: port,
    dashboardPassword: optional("DASHBOARD_PASSWORD"),
    reportSecret,
    reportsPort,
  };
}
