import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@jarvis/shared";
import { agentGraphFor, AGENTS_POLL_MS } from "./agents/index.js";
import { Brain } from "./brain/index.js";
import { createBot } from "./bot.js";
import { BriefService, useBrief } from "./brief.js";
import { notifier, notify } from "./notify.js";
import { Scheduler, useScheduler } from "./scheduler.js";
import { ReportWatcher, useReportWatcher } from "./notifyRules.js";
import { memory } from "./tools/memory.js";
import { CalendarLog, useCalendarLog } from "./calendarLog.js";
import { UploadStore } from "./uploads.js";
import { createWorker } from "./brain/worker.js";
import { createBrowserBrain } from "./browser/brain.js";
import { BrowserTaskRunner, useBrowserTasks } from "./browser/tasks.js";
import { discoverJobs, JobRunner, useJobRunner } from "./jobs/index.js";
import { MEMORY_POLL_MS } from "./memory.js";
import { suggesterFor } from "./suggest/index.js";
import { DeviceStore } from "./desk/auth.js";
import { DeskRpc } from "./desk/rpc.js";
import { DeskRouter, type DeskContext } from "./desk/routes/index.js";
import { SseHub } from "./desk/sse.js";
import { bus } from "./events.js";
import { authStatus } from "./cloud.js";
import { loadConfig } from "./config.js";
import { Jarvis } from "./jarvis.js";
import { recordSessionUsage, SessionUsageLog, SNAPSHOT_MS } from "./sessionUsage.js";
import { Store } from "./store.js";
import { SystemMonitor, useSystemMonitor } from "./system.js";
import { ToolRegistry, type ToolContext } from "./tools/index.js";
import { createDashboard, createReportsServer } from "./web.js";

const config = loadConfig();
const jarvis = new Jarvis(config, new Store(config.dataDir));

// Timers and reminders (started below, once Telegram is attached, so missed ones reach the phone).
const scheduler = new Scheduler(config.dataDir, { bus, notify });
useScheduler(jarvis, scheduler);

const monitor = new SystemMonitor();
monitor.start();
useSystemMonitor(jarvis, monitor);
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
// The change log and undo for calendar writes (src/tools/calendar.ts records directly; JD-77).
const calendarLog = new CalendarLog(config.dataDir, bus);
useCalendarLog(jarvis, calendarLog);
const deskCtx: DeskContext = { jarvis, bus, devices: new DeviceStore(config.dataDir), hub: new SseHub(bus), rpc: new DeskRpc(bus), brain };
const deskRouter = await DeskRouter.discover();
const toolContext: ToolContext = { jarvis, config, desk: deskCtx };
console.log(
  `brain: ${brain.model} (${brain.warm ? "warm, streaming" : "one process per message"}), tools: ${registry.list().length} in ${registry.groups.length} groups${config.notionToken ? ", Notion connected" : ", no Notion (NOTION_TOKEN unset)"}` +
    `, claude.ai connectors: ${config.brainConnectors.join(", ") || "none"}` +
    `, Google Calendar: ${config.googleCalendar ? "connected (first-party)" : "not connected (run npm run setup:calendar)"}`,
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
// Fires anything that came due while JARVIS was down (marked late), then ticks every second.
scheduler.start();
// Session reports → Telegram alerts (blocked, waiting on you, finished, failed) and the orb's mood.
const reportWatcher = new ReportWatcher(jarvis.store, bus, notifier, () => jarvis.status().then((st) => st.usage));
useReportWatcher(jarvis, reportWatcher);
reportWatcher.start();
// The worker brain runs background jobs (Today digest…) in its own conversation (ADR 0007).
const worker = createWorker(
  {
    claudeBin: config.claudeBin,
    dataDir: config.dataDir,
    models: config.brainModels,
    defaultModel: config.brainModel,
    model: process.env.WORKER_MODEL || undefined,
    internalUrl: `http://127.0.0.1:${config.dashboardPort}`,
    internalToken,
  },
  toolContext,
  () => jobRunner.submitToolNames,
);
const jobRunner = new JobRunner(await discoverJobs(), worker, toolContext, { dataDir: config.dataDir, bus, usage: () => jarvis.status().then((st) => st.usage) });
useJobRunner(jarvis, jobRunner);
scheduler.every("jobs", 60_000, () => void jobRunner.tick());
// Browser tasks (JD-60): their own worker conversation drives the Mac's browser over rpc.
const browserTasks = new BrowserTaskRunner({
  dataDir: config.dataDir,
  bus,
  brain: createBrowserBrain({
    claudeBin: config.claudeBin,
    dataDir: config.dataDir,
    models: config.brainModels,
    defaultModel: config.brainModel,
    model: process.env.WORKER_MODEL || undefined,
    internalUrl: `http://127.0.0.1:${config.dashboardPort}`,
    internalToken,
  }),
  mac: { connected: () => deskCtx.hub.clientCount > 0, call: (kind, payload) => deskCtx.rpc.call(kind, payload) },
  telegram: (text) => notifier.sendTelegram(text),
  chat: jarvis.store,
});
useBrowserTasks(jarvis, browserTasks);
// The morning brief (Desk POST /brief, the first Desk voice turn of the morning, Telegram /brief).
useBrief(jarvis, new BriefService({ ctx: toolContext, brain, bus, runner: () => jobRunner }));
// To-do suggestions: from session reports at once, Notion QA every 30 min (Slack + email is a job).
suggesterFor(toolContext).start((name, ms, fn) => scheduler.every(name, ms, fn));

// The agent graph (JD-57): re-read every 30 s while a Desk is connected; agents.changed on a change.
const agents = agentGraphFor(jarvis, bus);
scheduler.every("agents", AGENTS_POLL_MS, async () => {
  if (deskCtx.hub.clientCount) await agents.refresh();
});

// Uploaded files are kept for 7 days.
const uploads = new UploadStore(config.dataDir);
uploads.cleanup();
scheduler.every("uploads-cleanup", 24 * 60 * 60_000, () => void uploads.cleanup());
// Each cloud session's cumulative cost and tokens, now and every hour (the System window's projects
// and 30-day history, JD-55).
const sessionUsage = new SessionUsageLog(config.dataDir);
const snapshotUsage = () => recordSessionUsage(jarvis, sessionUsage).then(() => undefined);
snapshotUsage().catch((err) => console.error("session usage snapshot failed:", err));
scheduler.every("session-usage", SNAPSHOT_MS, snapshotUsage);
// Matthew's edits to JARVIS Memory in Notion reach the brain within 10 minutes.
scheduler.every("memory-poll", MEMORY_POLL_MS, async () => void (await memory(toolContext).poll()));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    monitor.stop();
    scheduler.stop();
    reportWatcher.stop();
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
            { command: "brief", description: "Your morning brief" },
            { command: "jobs", description: "Sessions I'm tracking" },
            { command: "new", description: "Start a cloud session on a task" },
            { command: "use", description: "Pick which session plain messages go to" },
            { command: "say", description: "Message a specific session" },
            { command: "attach", description: "Add a session by link" },
            { command: "forget", description: "Stop tracking a session" },
            { command: "status", description: "Login, plan usage, routine fires" },
            { command: "voice", description: "Voice-note replies: on, off or auto" },
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
