import { Bot, type Context } from "grammy";
import { authStatus, sendToSession } from "./cloud.js";
import type { Config } from "./config.js";
import { newJobText, followUpText } from "./prompts.js";
import { fireRoutine } from "./routines.js";
import type { Job, Store } from "./store.js";

/** Documented per-routine cap on API fires (shared with "Run now"). Each /new is one fire. */
const FIRES_PER_HOUR = 30;

const HELP = [
  "JARVIS commands:",
  "/new <task> — start a cloud session on the task",
  "/jobs — sessions I've started",
  "/use <job> — pick which session plain messages go to",
  "/say <job> <message> — message a specific session",
  "/status — check my Claude login and setup",
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

export function createBot(config: Config, store: Store): Bot {
  const bot = new Bot(config.telegramBotToken);

  // Only Matthew's chat gets through. Before TELEGRAM_ALLOWED_CHAT_ID is set, the bot just reports
  // the chat ID so it can be configured.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (config.allowedChatId !== undefined && chatId === config.allowedChatId) return next();
    if (config.allowedChatId === undefined && chatId !== undefined) {
      await ctx.reply(
        `Setup mode. Your chat ID is ${chatId}.\nPut TELEGRAM_ALLOWED_CHAT_ID=${chatId} in .env and restart me.`,
      );
    }
    // Anyone else is ignored silently.
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

  bot.command("status", async (ctx) => {
    const auth = await authStatus(config.claudeBin);
    const lines = [
      `Claude login: ${auth.loggedIn ? "yes" : "NO"} (${auth.detail})`,
      ...(auth.warning ? [`⚠️ ${auth.warning}`] : []),
      `Routine: ${config.routineId && config.routineToken ? config.routineId : "not configured (ROUTINE_ID / ROUTINE_TOKEN)"}`,
      `Routine fires this hour: ${store.firesInLastHour().length}/${FIRES_PER_HOUR}`,
      `Current job: ${store.currentJob()?.id ?? "none"}`,
    ];
    await ctx.reply(lines.join("\n"));
  });

  bot.command("new", async (ctx) => {
    const task = ctx.match.trim();
    if (!task) return ctx.reply("Usage: /new <task>");
    if (!config.routineId || !config.routineToken) {
      return ctx.reply("No routine configured. Set ROUTINE_ID and ROUTINE_TOKEN (see README).");
    }
    const recent = store.firesInLastHour();
    if (recent.length >= FIRES_PER_HOUR) {
      const freeAt = new Date(recent[0].getTime() + 60 * 60 * 1000);
      return ctx.reply(
        `That would be fire ${recent.length + 1} this hour; the routine allows ${FIRES_PER_HOUR}. Next slot frees at ${freeAt.toISOString().slice(11, 16)} UTC. Follow-ups to existing jobs still work.`,
      );
    }
    const jobId = store.newJobId();
    const sentAt = new Date();
    try {
      const session = await fireRoutine(config.routineId, config.routineToken, newJobText(jobId, task, sentAt));
      store.recordFire(sentAt);
      const job: Job = { id: jobId, ...session, task, createdAt: sentAt.toISOString() };
      store.addJob(job);
      await ctx.reply(
        `Started ${jobId} in ${seconds(Date.now() - sentAt.getTime())} (fire ${recent.length + 1}/${FIRES_PER_HOUR} this hour). It'll message you here when it has something.\n${session.url}`,
      );
    } catch (err) {
      await ctx.reply(`Couldn't start ${jobId}: ${(err as Error).message}`);
    }
  });

  bot.command("jobs", async (ctx) => {
    const jobs = store.recentJobs();
    if (jobs.length === 0) return ctx.reply("No jobs yet. Start one with /new <task>.");
    const current = store.currentJob()?.id;
    await ctx.reply(jobs.map((j) => (j.id === current ? "▶ " : "") + describe(j)).join("\n\n"));
  });

  bot.command("use", async (ctx) => {
    const job = store.setCurrent(ctx.match.trim());
    await ctx.reply(job ? `Plain messages now go to ${describe(job)}` : "No such job. See /jobs.");
  });

  bot.command("say", async (ctx) => {
    const [jobId, ...rest] = ctx.match.trim().split(/\s+/);
    const job = jobId ? store.getJob(jobId) : undefined;
    if (!job || rest.length === 0) return ctx.reply("Usage: /say <job> <message>. See /jobs.");
    await relay(ctx, job, ctx.match.trim().slice(jobId.length).trim());
  });

  bot.on("message:text", async (ctx) => {
    const job = store.currentJob();
    if (!job) return ctx.reply("No current session. Start one with /new <task>, or /help.");
    await relay(ctx, job, ctx.message.text);
  });

  async function relay(ctx: Context, job: Job, message: string): Promise<void> {
    const sentAt = new Date();
    try {
      const result = await sendToSession(config.claudeBin, job.sessionId, followUpText(job.id, message, sentAt));
      if (result.ok) {
        store.touch(job.id);
        await ctx.reply(`Sent to ${job.id} in ${seconds(Date.now() - sentAt.getTime())}.`);
      } else {
        await ctx.reply(`Couldn't reach ${job.id}: ${result.error ?? "unknown error"}`);
      }
    } catch (err) {
      await ctx.reply(`Couldn't reach ${job.id}: ${(err as Error).message}`);
    }
  }

  bot.catch((err) => console.error("bot error:", err.error));
  return bot;
}
