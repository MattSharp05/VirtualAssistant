// Checks the setup without starting a session: `docker compose exec jarvis npm run doctor`.

import { authStatus } from "./cloud.js";
import { loadConfig } from "./config.js";

let failures = 0;
function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
}

const config = loadConfig();

const auth = await authStatus(config.claudeBin);
report(auth.loggedIn && !auth.warning, "claude login", auth.warning ?? auth.detail);

const me = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`)
  .then((r) => r.json() as Promise<{ ok: boolean; result?: { username: string }; description?: string }>)
  .catch((err: Error) => ({ ok: false, description: err.message, result: undefined }));
report(me.ok, "telegram bot", me.ok ? `@${me.result?.username}` : (me.description ?? "unreachable"));

report(config.allowedChatId !== undefined, "allowed chat", String(config.allowedChatId ?? "unset (send /start to the bot)"));
report(Boolean(config.routineId && config.routineToken), "routine", config.routineId ?? "ROUTINE_ID / ROUTINE_TOKEN unset");

process.exit(failures ? 1 : 0);
