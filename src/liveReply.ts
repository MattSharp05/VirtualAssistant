// A Telegram message that grows while the brain writes (JD-6): sent once the first sentence is
// ready, then edited as text arrives, at most once per `minGapMs` (Telegram rate-limits edits), and a
// final edit with the whole reply and its metrics footer. Replies longer than one message continue
// in follow-up messages.

export interface LiveReplyIO {
  send(text: string): Promise<number>;
  edit(messageId: number, text: string): Promise<void>;
}

/** Telegram caps messages at 4096 characters. */
export const MAX_MESSAGE = 4000;

export function chunks(text: string, size = MAX_MESSAGE): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

/** True once the text has a finished sentence (or enough words to be worth showing). */
export function hasFirstSentence(text: string): boolean {
  return /[.!?…:](\s|$)|\n/.test(text.trim() + " ") || text.length >= 120;
}

export class LiveReply {
  private text = "";
  private messageId?: number;
  private shown = "";
  /** When the last Telegram call started; the next one waits until minGapMs after it. */
  private lastCall = -Infinity;
  private timer?: NodeJS.Timeout;
  private queued = false;
  /** Serializes Telegram calls so edits never overtake the first send. */
  private chain: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    private readonly io: LiveReplyIO,
    private readonly minGapMs = 1500,
  ) {}

  /** True once the first message is on screen (or on its way). */
  get started(): boolean {
    return this.queued || this.messageId !== undefined;
  }

  push(chunk: string): void {
    if (this.finished) return;
    this.text += chunk;
    if (!this.started) {
      if (hasFirstSentence(this.text)) this.update();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.update();
      }, Math.max(0, this.lastCall + this.minGapMs - Date.now()));
    }
  }

  /** The final text (reply + footer): one last edit after the throttle, then any overflow as new messages. */
  async finish(finalText: string): Promise<void> {
    this.finished = true;
    clearTimeout(this.timer);
    const [first, ...rest] = chunks(finalText);
    await this.call(first); // errors reach the caller, so a failed final reply isn't silent
    for (const part of rest) await this.io.send(part);
  }

  /** Shows the text so far, with "…" while it's still being written. */
  private update(): void {
    this.queued = true;
    this.call(undefined).catch((err) => console.warn("live reply update failed:", (err as Error).message));
  }

  private call(fixed: string | undefined): Promise<void> {
    const run = this.chain.then(async () => {
      const text = fixed ?? chunks(this.text)[0] + (this.text.length > MAX_MESSAGE ? "" : " …");
      if (fixed === undefined && this.finished) return; // the final edit supersedes it
      if (text === this.shown) return;
      const wait = this.lastCall + this.minGapMs - Date.now();
      if (this.messageId !== undefined && wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      if (this.messageId === undefined) this.messageId = await this.io.send(text);
      else await this.edit(text);
      this.shown = text;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async edit(text: string): Promise<void> {
    try {
      await this.io.edit(this.messageId!, text);
    } catch (err) {
      // "message is not modified": the text on screen is already right.
      if (!/not modified/i.test((err as Error).message)) throw err;
    }
  }
}
