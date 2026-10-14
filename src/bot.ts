import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { formatMetrics, type Brain } from "./brain/index.js";
import { LiveReply } from "./liveReply.js";
import { MAX_UPLOAD_BYTES, UploadStore, type Upload } from "./uploads.js";
import { transcribe as whisperTranscribe, type Transcript } from "./voice/stt.js";
import type { Jarvis } from "./jarvis.js";
import type { Job } from "./store.js";

const HELP = [
  "Just talk to me: \"what's mk up to?\", \"tell mk to pause after this ticket\", \"what's in the ShapeMint PRD?\".",
  "",
  "Commands:",
  "/jarvis — talk to me (default)",
  "/model [name] — see or switch my model",
  "/newchat — start a fresh conversation",
  "/new <task> — start a cloud session on the task",
  "/sessions — pick a cloud session to talk to directly",
  "/jobs — sessions I'm tracking",
  "/use <job> — talk directly to a tracked session",
  "/attach <link> <name> [note] — add a session I didn't start (e.g. an orchestrator)",
  "/forget <job> — stop tracking a session",
  "/say <job> <message> — message a specific session",
  "/status — Claude login, plan usage, routine fires",
  "",
  "Plain messages go to me, or straight to a session after /sessions or /use.",
].join("\n");

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

/** What tests replace: downloading a Telegram file and speech-to-text. */
export interface BotDeps {
  download?: (filePath: string) => Promise<Uint8Array>;
  transcribe?: (audioPath: string) => Promise<Transcript>;
}

export function createBot(token: string, allowedChatId: number | undefined, jarvis: Jarvis, brain?: Brain, deps: BotDeps = {}): Bot {
  const bot = new Bot(token);
  const download =
    deps.download ??
    (async (filePath: string) => {
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
      if (!res.ok) throw new Error(`Telegram download failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    });
  const transcribe = deps.transcribe ?? ((path: string) => whisperTranscribe(path));
  const { store } = jarvis;
  const uploads = new UploadStore(jarvis.config.dataDir);

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
        `Notion: ${s.notion.state === "ok" ? `connected, ${s.notion.shared} pages shared` : s.notion.state === "off" ? "off (NOTION_TOKEN unset)" : s.notion.detail}`,
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

  // Your cloud sessions as buttons: tap one, then just type to message it.
  bot.command("sessions", async (ctx) => {
    const list = await jarvis.listSessions(true);
    if (!list.available) return ctx.reply(`Couldn't list your sessions: ${list.reason}\nYou can still /attach one by link.`);
    if (list.sessions.length === 0) return ctx.reply("No active cloud sessions.");
    const keyboard = new InlineKeyboard();
    for (const s of list.sessions.slice(0, 12)) {
      const when = s.lastActivityAt ? ` · ${ago(s.lastActivityAt)}` : "";
      keyboard.text(`${s.title.slice(0, 40)}${when}`, `pick:${s.id}`).row();
    }
    const more = list.sessions.length > 12 ? ` (newest 12 of ${list.sessions.length})` : "";
    await ctx.reply(`Your cloud sessions${more}. Tap one, then just type to message it:`, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^pick:((?:session|cse)_[A-Za-z0-9_-]+)$/, async (ctx) => {
    const id = ctx.match[1];
    const title = (await jarvis.listSessions()).sessions.find((s) => s.id === id)?.title ?? "";
    try {
      const job = jarvis.pickSession(id, title);
      await ctx.answerCallbackQuery({ text: `Talking to ${job.id}` });
      talkTo(job.id);
      await ctx.reply(`Plain messages now go straight to ${job.id}${title ? ` (${title})` : ""}. /jarvis to talk to me again.\n${job.url}`);
    } catch (err) {
      await ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 190), show_alert: true });
    }
  });

  bot.command("attach", async (ctx) => {
    const [link, name, ...note] = ctx.match.trim().split(/\s+/);
    if (!link || !name) return ctx.reply("Usage: /attach <claude.ai session link> <name> [note]");
    try {
      const job = jarvis.attachSession(link, name, note.join(" "));
      talkTo(job.id);
      await ctx.reply(`Attached ${job.id}. Plain messages now go straight to it; /jarvis to talk to me again.\n${job.url}`);
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
    if (!job) return ctx.reply("No such job. See /jobs.");
    talkTo(job.id);
    await ctx.reply(`Plain messages now go straight to ${describe(job)}\n/jarvis to talk to me again.`);
  });

  bot.command("jarvis", async (ctx) => {
    talkTo("jarvis");
    await ctx.reply(brain ? `Talking to me (${brain.model}). Ask me anything.` : "The brain isn't running.");
  });

  bot.command("newchat", async (ctx) => {
    if (!brain) return ctx.reply("The brain isn't running.");
    brain.reset();
    talkTo("jarvis");
    await ctx.reply("Fresh conversation started.");
  });

  bot.command("model", async (ctx) => {
    if (!brain) return ctx.reply("The brain isn't running.");
    const wanted = ctx.match.trim().toLowerCase();
    if (wanted) {
      const match = brain.models.find((m) => m === wanted) ?? brain.models.find((m) => m.includes(wanted));
      if (!match) return ctx.reply(`No model matching "${wanted}". Options: ${brain.models.join(", ")}`);
      brain.setModel(match);
      return ctx.reply(`Switched to ${match}.`);
    }
    const keyboard = new InlineKeyboard();
    for (const m of brain.models) keyboard.text(`${m === brain.model ? "✓ " : ""}${m}`, `model:${m}`).row();
    await ctx.reply(`I'm using ${brain.model}. Switch to:`, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    if (!brain) return ctx.answerCallbackQuery();
    try {
      brain.setModel(ctx.match[1]);
      await ctx.answerCallbackQuery({ text: `Switched to ${ctx.match[1]}` });
      await ctx.reply(`Switched to ${ctx.match[1]}.`);
    } catch (err) {
      await ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 190), show_alert: true });
    }
  });

  bot.command("say", async (ctx) => {
    const [jobId, ...rest] = ctx.match.trim().split(/\s+/);
    if (!jobId || rest.length === 0) return ctx.reply("Usage: /say <job> <message>. See /jobs.");
    await relay(ctx, jobId, ctx.match.trim().slice(jobId.length).trim());
  });

  bot.on("message:text", (ctx) => handleText(ctx, ctx.message.text));

  /** Typed text and voice transcripts go the same way: to the picked session, or to JARVIS. */
  async function handleText(ctx: Context, text: string): Promise<void> {
    const target = store.brain().talkTo ?? "jarvis";
    if (target !== "jarvis" && store.getJob(target)) return relay(ctx, target, text);
    await askBrain(ctx, text);
  }

  // Voice notes (and audio files): transcribed in the container (src/voice/stt.ts), echoed, then
  // handled exactly like typed text.
  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const audio = ctx.message.voice ?? ctx.message.audio;
    if ((audio?.file_size ?? 0) > MAX_UPLOAD_BYTES) return ctx.reply("That recording is too long for me.");
    let text: string;
    const dir = join(jarvis.config.dataDir, "voice");
    const path = join(dir, `${ctx.message.message_id}.ogg`);
    try {
      void ctx.replyWithChatAction("typing").catch(() => {});
      const file = await ctx.getFile();
      await mkdir(dir, { recursive: true });
      await writeFile(path, await download(file.file_path!));
      text = (await transcribe(path)).text;
    } catch (err) {
      console.warn("voice note:", (err as Error).message);
      return ctx.reply("I couldn't transcribe that. Try again, or type it?");
    } finally {
      await rm(path, { force: true });
    }
    if (!text) return ctx.reply("I didn't catch anything in that recording.");
    await ctx.reply(`🎙 <i>${escapeHtml(text)}</i>`, { parse_mode: "HTML" });
    await handleText(ctx, text);
  });

  // Documents and photos: saved to the uploads folder (src/uploads.ts), then JARVIS reads them.
  bot.on(["message:document", "message:photo"], async (ctx) => {
    if (!brain) return ctx.reply("The brain isn't running.");
    const doc = ctx.message.document;
    const photo = ctx.message.photo?.at(-1); // the largest size
    const size = doc?.file_size ?? photo?.file_size ?? 0;
    if (size > MAX_UPLOAD_BYTES) return ctx.reply(`That's over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; I can't take it.`);
    let upload: Upload;
    try {
      const file = await ctx.getFile();
      const name = doc?.file_name ?? `photo-${ctx.message.message_id}.jpg`;
      upload = uploads.save(name, await download(file.file_path!));
    } catch (err) {
      return ctx.reply(`I couldn't take that file: ${(err as Error).message.slice(0, 200)}`);
    }
    await askBrain(ctx, ctx.message.caption?.trim() || "Here's a file.", [upload]);
  });

  /** One message to the brain, with the reply growing in place (src/liveReply.ts). */
  async function askBrain(ctx: Context, text: string, attachments: Upload[] = []): Promise<void> {
    if (!brain) {
      await ctx.reply("The brain isn't running. Use /sessions to message a session directly.");
      return;
    }
    // "typing…" until the first sentence shows, then the reply grows in place.
    const chatId = ctx.chat!.id;
    const live = new LiveReply({
      send: async (t) => (await ctx.api.sendMessage(chatId, t)).message_id,
      edit: async (id, t) => void (await ctx.api.editMessageText(chatId, id, t)),
    });
    const typing = setInterval(() => void (live.started || ctx.replyWithChatAction("typing").catch(() => {})), 4500);
    void ctx.replyWithChatAction("typing").catch(() => {});
    try {
      const { reply, metrics } = await brain.chat(text, "telegram", { onDelta: (chunk) => live.push(chunk), attachments });
      clearInterval(typing);
      await live.finish(`${reply}\n\n${formatMetrics(metrics)}`);
    } catch (err) {
      await ctx.reply(`I couldn't answer that: ${(err as Error).message.slice(0, 300)}`);
    } finally {
      clearInterval(typing);
    }
  }

  function talkTo(target: string): void {
    store.updateBrain({ talkTo: target });
  }

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
