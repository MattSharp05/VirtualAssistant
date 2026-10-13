// Checks the setup without starting a session: `docker compose exec jarvis npm run doctor`.

import { authStatus } from "./cloud.js";
import { loadConfig } from "./config.js";
import { planUsage } from "./usage.js";

let failures = 0;
function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
}

const config = loadConfig();

const auth = await authStatus(config.claudeBin);
report(auth.loggedIn && !auth.warning, "claude login", auth.warning ?? auth.detail);

const usage = await planUsage(config.claudeBin);
console.log(
  `info plan usage: ${usage.available ? usage.windows.map((w) => `${w.name} ${Math.round(w.percent)}%`).join(", ") : `unavailable (${usage.reason})`}`,
);

if (config.telegramBotToken) {
  const me = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`)
    .then((r) => r.json() as Promise<{ ok: boolean; result?: { username: string }; description?: string }>)
    .catch((err: Error) => ({ ok: false, description: err.message, result: undefined }));
  report(me.ok, "telegram bot", me.ok ? `@${me.result?.username}` : (me.description ?? "unreachable"));
  report(config.allowedChatId !== undefined, "allowed chat", String(config.allowedChatId ?? "unset (send /start to the bot)"));
} else {
  console.log("info telegram: off (TELEGRAM_BOT_TOKEN unset), dashboard only");
}
report(Boolean(config.routineId && config.routineToken), "routine", config.routineId ?? "ROUTINE_ID / ROUTINE_TOKEN unset");
console.log(
  `info reports endpoint: ${config.reportSecret ? `on, port ${config.reportsPort} (expose it with Tailscale Funnel)` : "off (REPORT_SECRET unset)"}`,
);

process.exit(failures ? 1 : 0);
