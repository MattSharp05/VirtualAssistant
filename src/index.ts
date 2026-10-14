import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@jarvis/shared";
import { Brain } from "./brain/index.js";
import { createBot } from "./bot.js";
import { notifier } from "./notify.js";
import { DeviceStore } from "./desk/auth.js";
import { DeskRpc } from "./desk/rpc.js";
import { DeskRouter, type DeskContext } from "./desk/routes/index.js";
import { SseHub } from "./desk/sse.js";
import { bus } from "./events.js";
import { authStatus } from "./cloud.js";
import { loadConfig } from "./config.js";
import { Jarvis } from "./jarvis.js";
import { Store } from "./store.js";
import { SystemMonitor } from "./system.js";
import { ToolRegistry, type ToolContext } from "./tools/index.js";
import { createDashboard, createReportsServer } from "./web.js";

const config = loadConfig();
const jarvis = new Jarvis(config, new Store(config.dataDir));

const monitor = new SystemMonitor();
monitor.start();
// The brain's tool server reaches JARVIS on loopback with a token that lives only in this process.
const internalToken = randomBytes(32).toString("hex");
const registry = await ToolRegistry.discover();
const brain = new Brain(
  {
    claudeBin: config.claudeBin,
    dataDir: config.dataDir,
    models: config.brainModels,
    defaultModel: config.brainModel,
    internalUrl: `http://127.0.0.1:${config.dashboardPort}`,
    internalToken,
    setup: () => registry.brainSetup(toolContext),
    warm: config.brainWarm,
    bus,
  },
  jarvis.store,
);
const deskCtx: DeskContext = { jarvis, bus, devices: new DeviceStore(config.dataDir), hub: new SseHub(bus), rpc: new DeskRpc(bus), brain };
const deskRouter = await DeskRouter.discover();
const toolContext: ToolContext = { jarvis, config, desk: deskCtx };
console.log(
  `brain: ${brain.model} (${brain.warm ? "warm, streaming" : "one process per message"}), tools: ${registry.list().length} in ${registry.groups.length} groups${config.notionToken ? ", Notion connected" : ", no Notion (NOTION_TOKEN unset)"}` +
    `, claude.ai connectors: ${config.brainConnectors.join(", ") || "none"}`,
);

const dashboard = createDashboard(jarvis, { monitor, brain, registry, toolContext, internalToken, desk: { router: deskRouter, ctx: deskCtx } });
dashboard.listen(config.dashboardPort, () => {
  console.log(`dashboard on port ${config.dashboardPort} (Desk protocol v${PROTOCOL_VERSION})${config.dashboardPassword ? " (password protected)" : ""}`);
});

const reports = config.reportSecret ? createReportsServer(jarvis.store, config.reportSecret) : undefined;
reports?.listen(config.reportsPort, () => console.log(`reports endpoint on port ${config.reportsPort}`));

const auth = await authStatus(config.claudeBin);
console.log(`claude login: ${auth.loggedIn ? "yes" : "no"} (${auth.detail})`);
if (auth.warning) console.warn(auth.warning);
if (!auth.loggedIn) console.warn("Run: docker compose run --rm jarvis claude auth login");

const bot = config.telegramBotToken ? createBot(config.telegramBotToken, config.allowedChatId, jarvis, brain) : undefined;
const chatId = config.allowedChatId;
if (bot && chatId !== undefined) {
  notifier.attachTelegram(async (text) => {
    await bot.api.sendMessage(chatId, text);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    monitor.stop();
    brain.stop();
    deskCtx.hub.close();
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
            { command: "jarvis", description: "Talk to JARVIS (plain language)" },
            { command: "sessions", description: "Pick a cloud session to talk to directly" },
            { command: "model", description: "See or switch JARVIS's model" },
            { command: "newchat", description: "Start a fresh conversation with JARVIS" },
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
