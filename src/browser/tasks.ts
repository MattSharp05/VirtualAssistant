// Browser tasks (JD-60): Matthew asks for something on the web and JARVIS does it in the Mac's browser
// window (JD-59) on its own worker conversation, so the chat brain stays free.
//
// One task at a time. The runner sends the task to the browser brain (brain.ts) and waits for its turn
// to end. Every browser_* tool call comes back here (act): checked against the task's state, given a
// status line on the Mac, sent over rpc (with the task's mode and any approval for click/type), and
// logged. When Matthew must answer (browser_ask, a risky step the Mac refused, a password field, a
// pause or a take over) the task waits: the brain ends its turn, and his answer (the card's buttons,
// the Browser window, or the chat brain's browser_task_control) becomes the next message in the same
// conversation. browser_done ends it: the result goes back where it was asked (chat, voice, Telegram)
// and as a card. Every task's log (steps, URLs, approvals) is kept 30 days (DATA_DIR/browser-tasks.json).

import { randomBytes, randomUUID } from "node:crypto";
import {
  BROWSER_NEEDS_APPROVAL,
  BROWSER_NEEDS_MATTHEW,
  BROWSER_RPC,
  BROWSER_TAKEN_OVER,
  type BrainChannel,
  type BrowserActionResult,
  type BrowserTask,
  type BrowserTaskAnswerRequest,
  type BrowserTaskMode,
  type BrowserTaskOrigin,
  type BrowserTaskQuestion,
  type BrowserTaskResults,
  type BrowserTaskStep,
  type BrowserTaskSummary,
  type NoticeAction,
  type ScreenCard,
} from "@jarvis/shared";
import type { EventBus } from "../events.js";
import { JarvisError } from "../jarvis.js";
import { BROWSER_TASK_PROMPT, browserFollowUpText, browserTaskText } from "../prompts.js";
import { JsonFile } from "../storage.js";
import type { BrainMessage } from "../store.js";
import { modeFromText, modeRules } from "./risk.js";

export { BROWSER_TASK_PROMPT };

/** Logs older than this are dropped. */
export const KEEP_DAYS = 30;
const KEEP_TASKS = 200;
const KEEP_STEPS = 300;
/** The results panel scrolls; the overlay card shows the first few. */
const KEEP_RESULTS = 30;
const CARD_ITEMS = 12;
/** Turns that end with no browser_done and nothing to wait for get this many nudges, then the task fails. */
export const MAX_NUDGES = 2;

export const NOT_CONNECTED = "The Desk isn't connected, so I can't use the browser on Matthew's Mac right now.";
const END_TURN = "End your turn now without calling any more tools";

/** What the runner needs from the browser brain: one turn of its own conversation, and a fresh start. */
export interface TaskBrain {
  chat(text: string, channel: "worker"): Promise<unknown>;
  reset(): void;
}

/** The Mac, over rpc (src/desk/rpc.ts): absent or not connected means no Desk. */
export interface TaskMac {
  connected(): boolean;
  call(kind: string, payload: unknown): Promise<unknown>;
}

export interface BrowserTaskDeps {
  dataDir: string;
  bus: EventBus;
  brain: TaskBrain;
  mac: TaskMac;
  /** Results asked from Telegram go back there (notifier.sendTelegram). */
  telegram?: (text: string) => Promise<void>;
  /** The chat's conversation (Store): results asked in chat or by voice are added to it. */
  chat?: { addBrainMessage(message: BrainMessage): void };
  now?: () => Date;
  /** Approval tokens (tests pin them). */
  token?: () => string;
}

/** What a browser_* tool asks for: the rpc kind, its payload, and the brain's `step` for the status line. */
export interface TaskAction {
  kind: string;
  payload: Record<string, unknown>;
  step?: string;
  /** browser_click / browser_type: the token from Matthew's Approve. */
  approval?: string;
}

/** The card browser_done may put up with the result: `url` on an item that is a real, single page. */
export interface ResultCard {
  title?: string;
  items?: { label: string; detail?: string; url?: string }[];
  link?: { label: string; url: string };
}

interface StoredTask extends BrowserTask {
  /** Approval tokens Matthew gave, not yet used. */
  approvals: string[];
}

interface TasksFile {
  tasks: StoredTask[];
}

/** Where a result goes: the chat's channel for the origin (the Browser window's box has none). */
const CHANNEL: Partial<Record<BrowserTaskOrigin, BrainChannel>> = {
  "desk-typed": "desk-typed",
  "desk-voice": "desk-voice",
  dashboard: "dashboard",
  telegram: "telegram",
};

const ACTIVE = new Set(["running", "waiting", "paused"]);
const short = (s: string, n = 60) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export class BrowserTaskRunner {
  private readonly file: JsonFile<TasksFile>;
  /** The message the waiting loop gets next (Matthew's answer, a resume), or null for "stop". */
  private inbox?: string | null;
  private wake?: () => void;
  /** The last page JARVIS was on (for questions: "on lilia.example"). */
  private lastUrl = "";
  /** Where a follow-up's answer goes (JD-66), when it isn't where the task was asked. */
  private replyTo?: BrowserTaskOrigin;
  /** The newest loop: a follow-up asked while the last turn still winds down retires that turn's loop. */
  private runs = 0;
  /** The task whose conversation the browser brain holds (unknown after a restart: the newest task's). */
  private conversation?: string;

  constructor(private readonly deps: BrowserTaskDeps) {
    this.file = new JsonFile<TasksFile>(deps.dataDir, "browser-tasks", { tasks: [] });
    // A task that was running when JARVIS stopped can't go on: its conversation's turn is gone.
    const stale = this.file.get().tasks.filter((t) => ACTIVE.has(t.status));
    if (stale.length)
      void this.file.update((f) => ({
        tasks: f.tasks.map((t) =>
          ACTIVE.has(t.status) ? { ...t, status: "failed", result: "JARVIS restarted while this was running.", endedAt: this.iso(), question: undefined } : t,
        ),
      }));
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ── What the Desk and the chat brain see ──

  /** The last 30 days, newest first. */
  list(): BrowserTaskSummary[] {
    return this.kept().map(summary);
  }

  get(id: string): BrowserTask | undefined {
    const t = this.find(id);
    if (!t) return undefined;
    const { approvals: _approvals, ...task } = t;
    return task;
  }

  /** The task running, waiting or paused, if any. */
  get active(): BrowserTaskSummary | undefined {
    const t = this.current();
    return t && summary(t);
  }

  /** Deletes a finished task (done, stopped or failed) from the 30-day log for good (JD-67). */
  forget(id: string): Promise<void> {
    const t = this.mine(id);
    if (ACTIVE.has(t.status)) throw new JarvisError(`The task is ${t.status}. Stop it first, then delete it.`);
    return this.save((tasks) => tasks.filter((x) => x.id !== id));
  }

  // ── Starting ──

  /** Starts a task (queued work isn't a thing: one browser, one task). Throws when one is going or no Desk. */
  start(request: { text: string; mode?: BrowserTaskMode; origin: BrowserTaskOrigin }): BrowserTaskSummary {
    const text = request.text.trim();
    if (!text) throw new JarvisError("Say what to do in the browser.");
    const going = this.current();
    if (going) throw new JarvisError(`A browser task is already ${going.status}: “${short(going.text)}”. Stop it first, or wait for it.`);
    if (!this.deps.mac.connected()) throw new JarvisError(NOT_CONNECTED);
    const mode = modeFromText(text, request.mode);
    const at = this.iso();
    const task: StoredTask = {
      id: randomUUID(),
      text: text.slice(0, 2000),
      mode,
      status: "running",
      origin: request.origin,
      startedAt: at,
      step: "Starting",
      steps: 1,
      log: [{ at, kind: "start", text: `${mode === "full" ? "Full autonomy" : "Normal"}: ${short(text, 200)}` }],
      approvals: [],
    };
    void this.save((tasks) => [task, ...tasks]);
    this.inbox = undefined;
    this.lastUrl = "";
    this.replyTo = undefined;
    this.conversation = task.id;
    this.publish(task);
    void this.status(`Starting: ${short(text, 80)}`);
    void this.loop(task.id, browserTaskText(text, modeRules(mode), at));
    return summary(task);
  }

  /**
   * A follow-up on a finished task (JD-66): a question or an instruction about its results ("is that one
   * direct?", "add it to my to-do list"). The newest task, when it's done and nothing else has started
   * since, takes more turns of the same conversation (no reset), browsing again if it needs to.
   */
  followUp(id: string, request: { text: string; item?: number }, origin: BrowserTaskOrigin = "browser"): BrowserTaskSummary {
    const text = request.text.trim();
    if (!text) throw new JarvisError("Say what to do with it.");
    const t = this.reopenable(id);
    if (!this.deps.mac.connected()) throw new JarvisError(NOT_CONNECTED);
    const item = request.item === undefined ? undefined : t.results?.items[request.item];
    if (request.item !== undefined && !item) throw new JarvisError("That result isn't on the task.");
    this.log(id, { kind: "answer", text: `Matthew followed up${item ? ` on “${short(item.label, 80)}”` : ""}: ${short(text, 300)}`, ...(item?.url ? { url: item.url } : {}) });
    this.update(id, { status: "running", step: "Following up", endedAt: undefined });
    this.inbox = undefined;
    this.replyTo = origin;
    void this.status(`Following up: ${short(text, 80)}`);
    const reopened = summary(this.find(id)!);
    void this.loop(id, browserFollowUpText({ task: t.text, result: t.result ?? "", item, text, now: this.iso() }), false);
    return reopened;
  }

  /** The task a follow-up reopens: done, the newest, and nothing running (its conversation is still the brain's). */
  private reopenable(id: string): StoredTask {
    const t = this.mine(id);
    const going = this.current();
    if (going) throw new JarvisError(`A browser task is already ${going.status}: “${short(going.text)}”. Stop it first, or wait for it.`);
    if (t.status !== "done") throw new JarvisError(`That task ${t.status === "stopped" ? "was stopped" : "didn't finish"}, so it can't be picked up again. Start a new one.`);
    // The brain's conversation is the newest task's; a deleted newer task (JD-67) took it with it.
    if (this.file.get().tasks[0]?.id !== id || (this.conversation !== undefined && this.conversation !== id))
      throw new JarvisError("Another browser task has started since, so this one can't be picked up again. Start a new one.");
    return t;
  }

  /** The task's conversation: one turn, then wait for Matthew if it asked, until it's done or stopped. */
  private async loop(id: string, first: string, fresh = true): Promise<void> {
    if (fresh) this.deps.brain.reset(); // every task is a fresh conversation; a follow-up carries on the same one
    const run = ++this.runs;
    let message: string | null = first;
    let nudges = 0;
    while (message !== null) {
      try {
        await this.deps.brain.chat(message, "worker");
      } catch (err) {
        if (run === this.runs && this.isActive(id)) this.fail(id, `The browser brain stopped: ${(err as Error).message}`);
        return;
      }
      if (run !== this.runs) return;
      const t = this.find(id);
      if (!t || !ACTIVE.has(t.status)) return;
      if (this.inbox !== undefined) {
        message = this.inbox;
        this.inbox = undefined;
      } else if (t.status === "waiting" || t.status === "paused") {
        message = await this.next();
      } else if (++nudges > MAX_NUDGES) {
        this.fail(id, "JARVIS stopped without finishing or saying why.");
        return;
      } else {
        message = "You ended your turn without browser_done. If the task is finished (or can't be done), call browser_done now; if you need Matthew, call browser_ask; otherwise carry on.";
      }
    }
  }

  /** Waits for Matthew's answer, a resume, or a stop (null). */
  private next(): Promise<string | null> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.inbox === undefined) return;
        const m = this.inbox;
        this.inbox = undefined;
        this.wake = undefined;
        resolve(m);
      };
      this.wake = check;
      check();
    });
  }

  private send(message: string | null): void {
    this.inbox = message;
    this.wake?.();
  }

  // ── The browser_* tools (the browser brain's calls) ──

  /** One browser action for the running task. Returns what the brain reads; throws a JarvisError for a tool error. */
  async act(action: TaskAction): Promise<BrowserActionResult & Record<string, unknown>> {
    const t = this.usable();
    let payload = action.payload;
    if (action.kind === BROWSER_RPC.click || action.kind === BROWSER_RPC.type) {
      const approval = action.approval?.trim();
      if (approval && !t.approvals.includes(approval))
        throw new JarvisError("That approval isn't one Matthew gave (or it was used already). Ask him with browser_ask.");
      payload = { ...payload, task: { taskId: t.id, mode: t.mode, ...(approval ? { approval } : {}) } };
    }
    const step = short(action.step || defaultStep(action), 120);
    this.update(t.id, { step });
    void this.status(step);
    let out: BrowserActionResult & Record<string, unknown>;
    try {
      out = (await this.deps.mac.call(action.kind, payload)) as BrowserActionResult & Record<string, unknown>;
    } catch (err) {
      return this.refused(t.id, step, (err as Error).message);
    }
    if (typeof out?.url === "string" && out.url) this.lastUrl = out.url;
    const approval = (payload.task as { approval?: string } | undefined)?.approval;
    if (approval) {
      this.update(t.id, (s) => ({ approvals: s.approvals.filter((a) => a !== approval) }));
      this.log(t.id, { kind: "approval", text: `Used Matthew's approval: ${step}`, url: out?.url });
    } else if (action.kind !== BROWSER_RPC.snapshot) {
      this.log(t.id, { kind: "action", text: step, ...(out?.url ? { url: out.url } : {}) });
    }
    return out;
  }

  /** A refusal from the Mac: a risky step, a secret field, or Matthew's take over make the task wait. */
  private refused(id: string, step: string, error: string): never {
    const site = hostOf(this.lastUrl);
    const on = site ? ` on ${site}` : "";
    if (error.startsWith(BROWSER_NEEDS_APPROVAL)) {
      const what = /clicking (‘[^’]*’|the \w+)/.exec(error)?.[1] ?? "that";
      this.log(id, { kind: "refused", text: `The Mac stopped “${step}” for Matthew's approval`, ...(this.lastUrl ? { url: this.lastUrl } : {}) });
      this.ask(`OK to click ${what}${on}? (${step})`, "approval");
      throw new JarvisError(`That step needs Matthew's approval, and he's been asked (Approve / Change / Stop). ${END_TURN}; his answer arrives as the next message.`);
    }
    if (error.startsWith(BROWSER_NEEDS_MATTHEW)) {
      const what = /asks for ([^.]+)\./.exec(error)?.[1] ?? "something only you type";
      this.log(id, { kind: "refused", text: `Stopped at a field Matthew types himself (${what})`, ...(this.lastUrl ? { url: this.lastUrl } : {}) });
      this.ask(`The page${on} asks for ${what}. Take over, type it yourself, then Hand back.`, "takeover");
      throw new JarvisError(`Matthew types that himself; he's been asked to take over. ${END_TURN}; you'll get a message when he hands back.`);
    }
    if (error.startsWith(BROWSER_TAKEN_OVER)) {
      this.log(id, { kind: "pause", text: "Matthew took over the browser" });
      this.wait(id, { id: randomUUID(), kind: "takeover", text: "You have the browser. Hand back when you want JARVIS to carry on.", at: this.iso() });
      throw new JarvisError(`Matthew has taken over the browser. ${END_TURN}; you'll get a message when he hands back.`);
    }
    throw new JarvisError(error);
  }

  /** browser_ask: a question for Matthew (a card, spoken when the task came by voice); the task waits. */
  ask(text: string, kind: BrowserTaskQuestion["kind"] = "question"): BrowserTaskQuestion {
    const t = this.usable();
    const question: BrowserTaskQuestion = { id: randomUUID(), kind, text: short(text, 400), at: this.iso() };
    this.log(t.id, { kind: "ask", text: question.text, ...(this.lastUrl ? { url: this.lastUrl } : {}) });
    this.wait(t.id, question);
    this.deps.bus.publish({
      type: "notice",
      id: questionCardId(t.id),
      at: question.at,
      level: kind === "question" ? "info" : "warn",
      title: kind === "approval" ? "JARVIS needs your OK" : kind === "takeover" ? "Over to you in the browser" : "JARVIS has a question",
      body: question.text,
      actions: questionActions(t.id, question),
    });
    if (t.origin === "desk-voice") this.deps.bus.publish({ type: "browser.say", text: spoken(question) });
    if (t.origin === "telegram")
      void this.deps.telegram?.(`🌐 ${question.text}\n${kind === "approval" ? "Reply “go ahead”, a change, or “stop”." : kind === "takeover" ? "It's waiting in the Browser window on your Mac." : "Reply with your answer."}`);
    return question;
  }

  private wait(id: string, question: BrowserTaskQuestion): void {
    this.update(id, { status: "waiting", question, step: `Waiting for you: ${short(question.text, 90)}` });
    void this.status(`Waiting for you · ${short(question.text, 90)}`);
  }

  /** browser_done: the result, back where it was asked and as a card. A follow-up's answer keeps the earlier results. */
  done(summaryText: string, card?: ResultCard): BrowserTaskSummary {
    const t = this.usable(true);
    const result = short(summaryText, 1500) || "Done.";
    // A card with no rows (a title, a link) doesn't replace a follow-up's earlier results.
    const found = resultsOf(card);
    const results = found && (found.items.length || !t.results) ? found : undefined;
    const ended = this.finish(t.id, "done", result, results ? { results } : {});
    this.deliver(ended, result, results);
    return summary(ended);
  }

  // ── Matthew's side (Desk routes, the cards' buttons, the chat brain) ──

  answer(id: string, a: BrowserTaskAnswerRequest): BrowserTaskSummary {
    const t = this.mine(id);
    if (t.status !== "waiting" || !t.question) throw new JarvisError("That task isn't waiting for an answer.");
    if (a.questionId && a.questionId !== t.question.id) throw new JarvisError("That question has already been answered.");
    if (a.answer === "stop") return this.stop(id);
    const q = t.question;
    const text = (a.text ?? "").trim();
    let message: string;
    if (a.answer === "approve") {
      if (q.kind === "takeover") return this.resume(id);
      const token = this.deps.token?.() ?? `appr-${randomBytes(6).toString("hex")}`;
      this.update(id, (s) => ({ approvals: [...s.approvals, token] }));
      this.log(id, { kind: "approval", text: `Matthew approved: ${q.text}` });
      message = `Matthew approved: “${q.text}”. Do that step now: pass approval "${token}" to the browser_click (or browser_type) that does it. The approval is good for that one step.`;
    } else if (a.answer === "change") {
      if (!text) throw new JarvisError("Say what to change.");
      this.log(id, { kind: "answer", text: `Matthew wants a change: ${short(text, 300)}` });
      message = `Matthew doesn't want that step as it is. He says: “${text}”. Don't do the step he was asked about; adjust and carry on (ask again before any step that commits).`;
    } else {
      if (!text) throw new JarvisError("Give the answer.");
      this.log(id, { kind: "answer", text: `Matthew answered: ${short(text, 300)}` });
      message = `Matthew answered your question “${q.text}”: “${text}”. Carry on.`;
    }
    this.update(id, { status: "running", question: undefined, step: "Carrying on" });
    void this.status("Carrying on");
    this.dismissQuestion(id);
    this.send(message);
    return summary(this.find(id)!);
  }

  pause(id: string): BrowserTaskSummary {
    const t = this.mine(id);
    if (t.status !== "running") throw new JarvisError(`The task is ${t.status}, so it can't be paused.`);
    this.log(id, { kind: "pause", text: "Paused by Matthew" });
    this.update(id, { status: "paused", step: "Paused" });
    void this.status("Paused · Resume when you're ready");
    return summary(this.find(id)!);
  }

  /** Carries on after a pause, a take over or a password Matthew typed himself (Hand back). */
  resume(id: string): BrowserTaskSummary {
    const t = this.mine(id);
    const handBack = t.status === "waiting" && t.question?.kind === "takeover";
    if (t.status !== "paused" && !handBack) return summary(t); // nothing to resume (e.g. a stray Hand back)
    this.log(id, { kind: "resume", text: handBack ? "Matthew handed the browser back" : "Resumed by Matthew" });
    this.update(id, { status: "running", question: undefined, step: "Carrying on" });
    void this.status("Carrying on");
    this.dismissQuestion(id);
    this.send(
      handBack
        ? "Matthew did his part himself and handed the browser back. Take a snapshot (the page may have changed) and carry on."
        : "Matthew resumed the task. Take a snapshot first (the page may have changed) and carry on.",
    );
    return summary(this.find(id)!);
  }

  stop(id: string): BrowserTaskSummary {
    const t = this.mine(id);
    if (!ACTIVE.has(t.status)) return summary(t);
    const ended = this.finish(id, "stopped", "Stopped by Matthew.");
    this.dismissQuestion(id);
    this.send(null);
    return summary(ended);
  }

  // ── Internals ──

  /** The task the tools act for; refuses while it waits, is paused or was stopped. */
  private usable(finishing = false): StoredTask {
    const t = this.current() ?? this.kept().find((x) => x.status === "stopped" && this.now().getTime() - Date.parse(x.endedAt ?? "") < 5 * 60_000);
    if (!t) throw new JarvisError("No browser task is running.");
    if (t.status === "stopped") throw new JarvisError(`Matthew stopped the task. ${END_TURN}.`);
    if (t.status === "paused") throw new JarvisError(`Matthew paused the task. ${END_TURN}; you'll get a message when he resumes.`);
    if (t.status === "waiting" && !finishing) throw new JarvisError(`You're waiting for Matthew (${short(t.question?.text ?? "", 80)}). ${END_TURN}; his answer arrives as the next message.`);
    if (!finishing && !this.deps.mac.connected()) throw new JarvisError(NOT_CONNECTED);
    return t;
  }

  private current(): StoredTask | undefined {
    return this.file.get().tasks.find((t) => ACTIVE.has(t.status));
  }

  private isActive(id: string): boolean {
    const t = this.find(id);
    return !!t && ACTIVE.has(t.status);
  }

  private find(id: string): StoredTask | undefined {
    return this.file.get().tasks.find((t) => t.id === id);
  }

  private mine(id: string): StoredTask {
    const t = this.find(id);
    if (!t) throw new JarvisError(`No browser task ${id}.`);
    return t;
  }

  private kept(): StoredTask[] {
    const since = this.now().getTime() - KEEP_DAYS * 24 * 60 * 60_000;
    return this.file.get().tasks.filter((t) => Date.parse(t.startedAt) >= since);
  }

  private save(change: (tasks: StoredTask[]) => StoredTask[]): Promise<void> {
    const since = this.now().getTime() - KEEP_DAYS * 24 * 60 * 60_000;
    return this.file.update((f) => ({
      tasks: change(f.tasks)
        .filter((t) => ACTIVE.has(t.status) || Date.parse(t.startedAt) >= since)
        .slice(0, KEEP_TASKS),
    }));
  }

  private update(id: string, patch: Partial<StoredTask> | ((t: StoredTask) => Partial<StoredTask>)): void {
    let changed: StoredTask | undefined;
    void this.save((tasks) =>
      tasks.map((t) => {
        if (t.id !== id) return t;
        changed = { ...t, ...(typeof patch === "function" ? patch(t) : patch) };
        if (changed.question === undefined) delete changed.question;
        return changed;
      }),
    );
    if (changed) this.publish(changed);
  }

  private log(id: string, step: Omit<BrowserTaskStep, "at">): void {
    this.update(id, (t) => {
      const log = [...t.log, { at: this.iso(), ...step }].slice(-KEEP_STEPS);
      return { log, steps: log.length };
    });
  }

  private finish(id: string, status: "done" | "stopped" | "failed", result: string, extra: Partial<StoredTask> = {}): StoredTask {
    this.log(id, { kind: status === "done" ? "done" : status === "stopped" ? "stop" : "error", text: result });
    this.update(id, { status, result, endedAt: this.iso(), question: undefined, step: undefined, approvals: [], ...extra });
    void this.status(""); // the toolbar's line goes back to "Ready"
    return this.find(id)!;
  }

  private fail(id: string, why: string): void {
    const t = this.finish(id, "failed", why);
    this.deliver(t, `I couldn't finish “${short(t.text, 80)}”: ${why}`);
  }

  private publish(t: StoredTask): void {
    this.deps.bus.publish({ type: "browser.task", task: summary(t) });
  }

  private dismissQuestion(id: string): void {
    this.deps.bus.publish({ type: "card.dismiss", id: questionCardId(id) });
  }

  /** The Mac's status line (best effort: a Desk that went away doesn't stop the task here). */
  private async status(text: string): Promise<void> {
    if (!this.deps.mac.connected()) return;
    await this.deps.mac.call(BROWSER_RPC.status, { text }).catch(() => undefined);
  }

  /**
   * The result back where it was asked: Telegram, or the chat (spoken for voice), and as a card beside the
   * orb. Asked from the Browser window, the window's results panel shows it instead (JD-66).
   */
  private deliver(t: StoredTask, text: string, results?: BrowserTaskResults): void {
    const { bus } = this.deps;
    const followUp = this.replyTo !== undefined;
    const origin = this.replyTo ?? t.origin;
    this.replyTo = undefined;
    const items = (results?.items ?? []).slice(0, CARD_ITEMS);
    const shown: ScreenCard = {
      // A follow-up's answer is its own card: the list card stays.
      id: `browser-task-${t.id}${followUp ? `-${t.steps}` : ""}`,
      createdAt: this.iso(),
      title: short(results?.title || (t.status === "done" ? `Done: ${t.text}` : `Couldn't finish: ${t.text}`), 80),
      body: text,
      kind: items.length ? "list" : "text",
      ...(items.length ? { items } : {}),
      ...(results?.link ? { link: results.link } : {}),
    };
    if (origin !== "browser") bus.publish({ type: "card.show", card: shown });
    if (origin === "telegram") void this.deps.telegram?.(`🌐 ${text}`);
    if (origin === "desk-voice") bus.publish({ type: "browser.say", text });
    const channel = CHANNEL[origin];
    if (channel && channel !== "telegram") {
      // The chat window shows it as JARVIS's reply; it's in the conversation's history too.
      this.deps.chat?.addBrainMessage({ at: this.iso(), from: "jarvis", channel, text });
      bus.publish({
        type: "brain.done",
        messageId: `browser-task-${t.id}${followUp ? `-${t.steps}` : ""}`,
        text,
        metrics: { ms: Date.parse(t.endedAt ?? this.iso()) - Date.parse(t.startedAt), model: "browser task", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, turns: t.steps },
      });
    }
  }
}

/** browser_done's card as the task's results: short labels, and only http(s) urls. */
function resultsOf(card: ResultCard | undefined): BrowserTaskResults | undefined {
  if (!card || typeof card !== "object") return undefined;
  const items = (Array.isArray(card.items) ? card.items : [])
    .filter((i) => i && String(i.label ?? "").trim())
    .slice(0, KEEP_RESULTS)
    .map((i) => {
      const url = webUrl(i.url);
      return { label: short(String(i.label), 120), ...(i.detail ? { detail: short(String(i.detail), 80) } : {}), ...(url ? { url } : {}) };
    });
  const link = webUrl(card.link?.url);
  if (!items.length && !link && !card.title) return undefined;
  return {
    title: short(String(card.title ?? ""), 80),
    items,
    ...(link ? { link: { label: short(card.link?.label || "Open", 40), url: link } } : {}),
  };
}

/** An http(s) address, or nothing. */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The question's card, so answering it anywhere takes it off the screen. */
export const questionCardId = (taskId: string) => `browser-task-${taskId}-question`;

function summary(t: StoredTask): BrowserTaskSummary {
  const { log: _log, approvals: _approvals, ...rest } = t;
  return rest;
}

/** The status line when the brain gave no `step`. */
function defaultStep(a: TaskAction): string {
  const p = a.payload;
  switch (a.kind) {
    case BROWSER_RPC.open:
      return `Opening ${hostOf(String(p.url ?? "")) || "a page"}`;
    case BROWSER_RPC.snapshot:
      return "Reading the page";
    case BROWSER_RPC.click:
      return `Clicking [${String(p.ref)}]`;
    case BROWSER_RPC.type:
      return `Typing into [${String(p.ref)}]`;
    case BROWSER_RPC.select:
      return `Choosing ${String(p.option ?? "")}`;
    case BROWSER_RPC.press:
      return `Pressing ${String(p.key ?? "")}`;
    case BROWSER_RPC.scroll:
      return "Scrolling";
    case BROWSER_RPC.wait:
      return "Waiting for the page";
    case BROWSER_RPC.screenshot:
      return "Looking at the page";
    case BROWSER_RPC.tabs:
      return "Checking the tabs";
    default:
      return "Working";
  }
}

/** The card's buttons: Approve / Change / Stop for an approval; Open the browser for the rest. */
export function questionActions(taskId: string, q: BrowserTaskQuestion): NoticeAction[] {
  const path = `/browser/tasks/${taskId}/answer`;
  const stop: NoticeAction = { label: "Stop", request: { path, body: { questionId: q.id, answer: "stop" } } };
  if (q.kind === "approval")
    return [
      { label: "Approve", request: { path, body: { questionId: q.id, answer: "approve" } } },
      { label: "Change", window: "browser" },
      stop,
    ];
  return [{ label: q.kind === "takeover" ? "Open browser" : "Answer", window: "browser" }, stop];
}

/** What voice says for a question. */
function spoken(q: BrowserTaskQuestion): string {
  if (q.kind === "approval") return `Before I go ahead: ${q.text.replace(/\s*\([^)]*\)\s*$/, "")} Say or tap approve, change or stop.`;
  if (q.kind === "takeover") return `${q.text} It's in the browser window.`;
  return q.text;
}

/** The process's runner, registered by index.ts (keyed by the JARVIS instance, like the job runner). */
const runners = new WeakMap<object, BrowserTaskRunner>();

export function useBrowserTasks(owner: object, runner: BrowserTaskRunner): void {
  runners.set(owner, runner);
}

export function browserTasksFor(owner: object): BrowserTaskRunner {
  const r = runners.get(owner);
  if (!r) throw new JarvisError("Browser tasks aren't running.");
  return r;
}
