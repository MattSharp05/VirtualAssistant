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
  return {
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
