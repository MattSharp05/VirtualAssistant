import { createBot } from "./bot.js";
import { authStatus } from "./cloud.js";
import { loadConfig } from "./config.js";
import { Jarvis } from "./jarvis.js";
import { Store } from "./store.js";
import { SystemMonitor } from "./system.js";
import { createDashboard } from "./web.js";

const config = loadConfig();
const jarvis = new Jarvis(config, new Store(config.dataDir));

const monitor = new SystemMonitor();
monitor.start();
const dashboard = createDashboard(jarvis, monitor);
dashboard.listen(config.dashboardPort, () => {
  console.log(`dashboard on port ${config.dashboardPort}${config.dashboardPassword ? " (password protected)" : ""}`);
});

const auth = await authStatus(config.claudeBin);
console.log(`claude login: ${auth.loggedIn ? "yes" : "no"} (${auth.detail})`);
if (auth.warning) console.warn(auth.warning);
if (!auth.loggedIn) console.warn("Run: docker compose run --rm jarvis claude auth login");

const bot = config.telegramBotToken ? createBot(config.telegramBotToken, config.allowedChatId, jarvis) : undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    monitor.stop();
    dashboard.close();
    void bot?.stop();
    if (!bot) process.exit(0);
  });
}

if (!bot) {
  console.log("TELEGRAM_BOT_TOKEN unset: Telegram off, dashboard only.");
} else {
  if (config.allowedChatId === undefined) console.warn("TELEGRAM_ALLOWED_CHAT_ID unset: setup mode, send /start to the bot.");
  // Long polling: the container only makes outbound calls, so it needs no public URL.
  try {
    await bot.start({ onStart: (me) => console.log(`Telegram online as @${me.username}`) });
  } catch (err) {
    const unauthorized = (err as { error_code?: number }).error_code === 401;
    console.error(unauthorized ? "Telegram rejected TELEGRAM_BOT_TOKEN. Check it with @BotFather." : err);
    process.exit(1);
  }
}
