import { Bot, type Context } from "grammy";
import type { Jarvis } from "./jarvis.js";
import type { Job } from "./store.js";

const HELP = [
  "JARVIS commands:",
  "/new <task> — start a cloud session on the task",
  "/jobs — sessions I've started",
  "/use <job> — pick which session plain messages go to",
  "/attach <link> <name> [note] — add a session I didn't start (e.g. an orchestrator)",
  "/forget <job> — stop tracking a session",
  "/say <job> <message> — message a specific session",
  "/status — Claude login, plan usage, routine fires",
  "",
  "Any other text goes to the current session.",
].join("\n");

function describe(job: Job): string {
  const sent = job.messagesSent ? `, ${job.messagesSent} follow-up${job.messagesSent === 1 ? "" : "s"}` : "";
  return `${job.id}: ${job.task.slice(0, 60)}${job.task.length > 60 ? "…" : ""}\nstarted ${ago(job.createdAt)}${sent}\n${job.url}`;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""} ago`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const WINDOW_LABEL = { five_hour: "5-hour window", seven_day: "Weekly" } as const;

export function createBot(token: string, allowedChatId: number | undefined, jarvis: Jarvis): Bot {
  const bot = new Bot(token);
  const { store } = jarvis;

  // Only Matthew's chat gets through. Before TELEGRAM_ALLOWED_CHAT_ID is set, the bot just reports
  // the chat ID so it can be configured.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (allowedChatId !== undefined && chatId === allowedChatId) return next();
    if (allowedChatId === undefined && chatId !== undefined) {
      await ctx.reply(
        `Setup mode. Your chat ID is ${chatId}.\nPut TELEGRAM_ALLOWED_CHAT_ID=${chatId} in .env and restart me.`,
      );
    }
    // Anyone else is ignored silently.
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

  bot.command("status", async (ctx) => {
    const s = await jarvis.status();
    const usage = s.usage.available
      ? s.usage.windows.map((w) => `${WINDOW_LABEL[w.name]}: ${Math.round(w.percent)}% used`)
      : [`Plan usage: unavailable (${s.usage.reason})`];
    await ctx.reply(
      [
        `Claude login: ${s.auth.loggedIn ? "yes" : "NO"} (${s.auth.detail})`,
        ...(s.auth.warning ? [`⚠️ ${s.auth.warning}`] : []),
        ...usage,
        `Routine: ${s.routineConfigured ? s.routineId : "not configured (ROUTINE_ID / ROUTINE_TOKEN)"}`,
        `Routine fires this hour: ${s.firesThisHour}/${s.firesPerHour}`,
        `Current job: ${store.currentJob()?.id ?? "none"}`,
      ].join("\n"),
    );
  });

  bot.command("new", async (ctx) => {
    const task = ctx.match.trim();
    if (!task) return ctx.reply("Usage: /new <task>");
    try {
      const { job, ms, fireNumber } = await jarvis.startJob(task);
      await ctx.reply(
        `Started ${job.id} in ${seconds(ms)} (fire ${fireNumber}/30 this hour). It'll report here when it has something.\n${job.url}`,
      );
    } catch (err) {
      await ctx.reply(`Couldn't start the job: ${(err as Error).message}`);
    }
  });

  bot.command("jobs", async (ctx) => {
    const jobs = store.recentJobs();
    if (jobs.length === 0) return ctx.reply("No jobs yet. Start one with /new <task>.");
    const current = store.currentJob()?.id;
    await ctx.reply(jobs.map((j) => (j.id === current ? "▶ " : "") + describe(j)).join("\n\n"));
  });

  bot.command("attach", async (ctx) => {
    const [link, name, ...note] = ctx.match.trim().split(/\s+/);
    if (!link || !name) return ctx.reply("Usage: /attach <claude.ai session link> <name> [note]");
    try {
      const job = jarvis.attachSession(link, name, note.join(" "));
      store.setCurrent(job.id);
      await ctx.reply(`Attached ${job.id}. Plain messages now go to it.\n${job.url}`);
    } catch (err) {
      await ctx.reply((err as Error).message);
    }
  });

  bot.command("forget", async (ctx) => {
    try {
      jarvis.forget(ctx.match.trim());
      await ctx.reply(`Forgot ${ctx.match.trim()}. The session itself is untouched.`);
    } catch (err) {
      await ctx.reply((err as Error).message);
    }
  });

  bot.command("use", async (ctx) => {
    const job = store.setCurrent(ctx.match.trim());
    await ctx.reply(job ? `Plain messages now go to ${describe(job)}` : "No such job. See /jobs.");
  });

  bot.command("say", async (ctx) => {
    const [jobId, ...rest] = ctx.match.trim().split(/\s+/);
    if (!jobId || rest.length === 0) return ctx.reply("Usage: /say <job> <message>. See /jobs.");
    await relay(ctx, jobId, ctx.match.trim().slice(jobId.length).trim());
  });

  bot.on("message:text", async (ctx) => {
    const job = store.currentJob();
    if (!job) return ctx.reply("No current session. Start one with /new <task>, or /help.");
    await relay(ctx, job.id, ctx.message.text);
  });

  async function relay(ctx: Context, jobId: string, message: string): Promise<void> {
    try {
      const { job, ms } = await jarvis.sendMessage(jobId, message);
      await ctx.reply(`Sent to ${job.id} in ${seconds(ms)}.`);
    } catch (err) {
      await ctx.reply((err as Error).message);
    }
  }

  bot.catch((err) => console.error("bot error:", err.error));
  return bot;
}
