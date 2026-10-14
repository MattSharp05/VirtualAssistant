export interface Config {
  /** Unset = no Telegram; the dashboard alone works. */
  telegramBotToken: string | undefined;
  /** Only this Telegram chat may use the bot. Unset = setup mode: the bot just tells you your chat ID. */
  allowedChatId: number | undefined;
  /** The routine that starts new cloud sessions (claude.ai/code/routines, API trigger). */
  routineId: string | undefined;
  routineToken: string | undefined;
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
  /** claude.ai connectors the brain may read (see CONNECTORS in src/tools/connectors.ts). Empty = none. */
  brainConnectors: string[];
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
  const connectors = optional("BRAIN_CONNECTORS") ?? "Google Calendar,Gmail,Slack";
  const brainConnectors = /^none$/i.test(connectors) ? [] : connectors.split(",").map((c) => c.trim()).filter(Boolean);
  return {
    brainConnectors,
    notionToken: optional("NOTION_TOKEN"),
    brainModels,
    brainModel,
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
    allowedChatId: chatId === undefined ? undefined : Number(chatId),
    routineId: optional("ROUTINE_ID"),
    routineToken: optional("ROUTINE_TOKEN"),
    dataDir: optional("DATA_DIR") ?? "./data",
    claudeBin: optional("CLAUDE_BIN") ?? "claude",
    dashboardPort: port,
    dashboardPassword: optional("DASHBOARD_PASSWORD"),
    reportSecret,
    reportsPort,
  };
}
