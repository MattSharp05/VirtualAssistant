import { createBot } from "./bot.js";
import { authStatus } from "./cloud.js";
import { loadConfig } from "./config.js";
import { Jarvis } from "./jarvis.js";
import { Store } from "./store.js";
import { SystemMonitor } from "./system.js";
import { createDashboard, createReportsServer } from "./web.js";

const config = loadConfig();
const jarvis = new Jarvis(config, new Store(config.dataDir));

const monitor = new SystemMonitor();
monitor.start();
const dashboard = createDashboard(jarvis, monitor);
dashboard.listen(config.dashboardPort, () => {
  console.log(`dashboard on port ${config.dashboardPort}${config.dashboardPassword ? " (password protected)" : ""}`);
});

const reports = config.reportSecret ? createReportsServer(jarvis.store, config.reportSecret) : undefined;
reports?.listen(config.reportsPort, () => console.log(`reports endpoint on port ${config.reportsPort}`));

const auth = await authStatus(config.claudeBin);
console.log(`claude login: ${auth.loggedIn ? "yes" : "no"} (${auth.detail})`);
if (auth.warning) console.warn(auth.warning);
if (!auth.loggedIn) console.warn("Run: docker compose run --rm jarvis claude auth login");

const bot = config.telegramBotToken ? createBot(config.telegramBotToken, config.allowedChatId, jarvis) : undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    monitor.stop();
    dashboard.close();
    reports?.close();
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
    await bot.start({
      onStart: (me) => {
        console.log(`Telegram online as @${me.username}`);
        // The menu Telegram shows when you type "/".
        void bot.api
          .setMyCommands([
            { command: "sessions", description: "Pick one of your cloud sessions to talk to" },
            { command: "jobs", description: "Sessions I'm tracking" },
            { command: "new", description: "Start a cloud session on a task" },
            { command: "use", description: "Pick which session plain messages go to" },
            { command: "say", description: "Message a specific session" },
            { command: "attach", description: "Add a session by link" },
            { command: "forget", description: "Stop tracking a session" },
            { command: "status", description: "Login, plan usage, routine fires" },
          ])
          .catch((err) => console.warn("couldn't set the Telegram command menu:", (err as Error).message));
      },
    });
  } catch (err) {
    const unauthorized = (err as { error_code?: number }).error_code === 401;
    console.error(unauthorized ? "Telegram rejected TELEGRAM_BOT_TOKEN. Check it with @BotFather." : err);
    process.exit(1);
  }
}
