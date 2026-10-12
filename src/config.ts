export interface Config {
  telegramBotToken: string;
  /** Only this Telegram chat may use the bot. Unset = setup mode: the bot just tells you your chat ID. */
  allowedChatId: number | undefined;
  /** The routine that starts new cloud sessions (claude.ai/code/routines, API trigger). */
  routineId: string | undefined;
  routineToken: string | undefined;
  dataDir: string;
  claudeBin: string;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export function loadConfig(): Config {
  const chatId = optional("TELEGRAM_ALLOWED_CHAT_ID");
  if (chatId !== undefined && !/^-?\d+$/.test(chatId)) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_ID must be a number (send /start to the bot to get yours)");
  }
  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    allowedChatId: chatId === undefined ? undefined : Number(chatId),
    routineId: optional("ROUTINE_ID"),
    routineToken: optional("ROUTINE_TOKEN"),
    dataDir: optional("DATA_DIR") ?? "./data",
    claudeBin: optional("CLAUDE_BIN") ?? "claude",
  };
}
