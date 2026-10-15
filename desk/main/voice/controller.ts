// Push-to-talk (JD-31, the first half of ADR 0004's voice loop): a hotkey signal (hotkey.ts) listens
// once (VoiceSession.listen), shows what was heard in the "You said" bubble (voice.transcript, published
// locally like a server event) and asks JARVIS over the Desk API (channel desk-voice). The orb goes
// listening (with the mic level, from the session) → thinking (transcribing, then waiting for the reply)
// → idle on the reply's brain.done. Spoken replies (JD-38, speaker.ts) take over at the first sentence:
// the orb then rests once the last one has been said, and a press while JARVIS talks (⌥⌥) stops it at
// once and listens again. A second toggle while listening cancels; nothing heard shows "didn't catch
// that". The wake word (JD-43) starts the same turn with the audio heard just before. Each turn's
// timings go to `timing` (JD-48's LatencyTracker). Dependencies are injected: tested with a fake
// session, server and speaker.
import type { ChatResponse, DeskEvent, ScreenCard } from "@jarvis/shared";
import type { TurnTiming } from "../latency";
import { missedCard, TRANSCRIPT_CARD_ID, voiceErrorCard } from "./cards";
import type { PttSignal } from "./hotkey";
import type { ListenOptions, ListenResult } from "./session";

/** listening covers preparing and transcribing; replying = the first words of the reply are in. */
export type PttState = "idle" | "listening" | "thinking" | "replying";

/** A reply that never finishes (the connection dropped mid-answer) doesn't leave the orb thinking. */
export const REPLY_TIMEOUT_MS = 120_000;

export interface PushToTalkDeps {
  /** The VoiceSession's listen/stop/cancel. */
  listen(opts: ListenOptions): Promise<ListenResult>;
  stop(): void;
  cancel(): void;
  /** POST /api/desk/chat with channel desk-voice. */
  chat(text: string): Promise<ChatResponse>;
  publish(event: DeskEvent): void;
  /** How push-to-talk is started, for the "didn't catch that" card ("double-tap right ⌥"). */
  hint(): string;
  /** The Speaker (JD-38), when replies are spoken. */
  speech?: SpeechLike;
  /** Every state change (the wake word pauses while push-to-talk isn't idle, JD-43). */
  onState?(state: PttState): void;
  /** Voice latency (JD-48): where each turn has got to. */
  timing?: TurnTiming;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The parts of the Speaker push-to-talk uses. */
export interface SpeechLike {
  readonly busy: boolean;
  drained(): Promise<void>;
  interrupt(): void;
}

export class PushToTalk {
  private stateValue: PttState = "idle";
  /** Bumped by every start and cancel: a listen or chat that finishes for an older turn is dropped. */
  private turn = 0;
  /** The listen in flight (also a cancelled one still transcribing): a new listen waits for it. */
  private listening?: Promise<unknown>;
  private asked?: string;
  private messageId?: string;
  /** Replies that finished before the chat request answered with their id. */
  private finished = new Set<string>();
  private timeout?: unknown;
  /** Whether this turn's listen() has been called yet, and whether it should stop as soon as it is. */
  private started = false;
  private stopSoon = false;

  constructor(private readonly deps: PushToTalkDeps) {}

  get state(): PttState {
    return this.stateNow;
  }

  private get stateNow(): PttState {
    return this.stateValue;
  }

  private set stateNow(state: PttState) {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.deps.onState?.(state);
  }

  /** "Jarvis" was heard (JD-43): listen, starting with `preRoll`. False (ignored) unless idle. */
  wake(preRoll: Int16Array[]): boolean {
    if (this.stateNow !== "idle") return false;
    void this.start(preRoll);
    return true;
  }

  /** A signal from the hotkey (or the tray / Chat's mic button / ⌘⌥L, as a toggle). */
  signal(signal: PttSignal): void {
    if (signal === "toggle") return this.stateNow === "listening" ? this.cancel() : void this.start();
    if (signal === "hold-start") return this.stateNow === "listening" ? undefined : void this.start();
    if (signal === "hold-cancel") return this.stateNow === "listening" ? this.cancel() : undefined;
    // hold-end: let go, so what was said so far is transcribed and sent.
    if (this.stateNow !== "listening") return;
    if (this.started) this.deps.stop();
    else this.stopSoon = true; // still waiting for the previous listen to settle
  }

  /** Server events: follows the reply to its own question. */
  onEvent(e: DeskEvent): void {
    if (e.type === "brain.start") {
      // The reply can start before the chat request returns its id; claim it by its text.
      if (
        this.stateNow === "thinking" &&
        !this.messageId &&
        e.channel === "desk-voice" &&
        e.text === this.asked
      )
        this.messageId = e.messageId;
    } else if (e.type === "brain.delta") {
      if (e.messageId === this.messageId && this.stateNow === "thinking") this.stateNow = "replying"; // the speaker reads the same deltas
    } else if (e.type === "brain.done" || e.type === "brain.error") {
      if (this.stateNow !== "thinking" && this.stateNow !== "replying") return;
      if (!this.messageId) {
        this.finished.add(e.messageId);
        return;
      }
      if (e.messageId !== this.messageId) return;
      if (e.type === "brain.error")
        this.card(voiceErrorCard(new Error(e.error), this.now(), "JARVIS couldn't answer"));
      this.replied();
    }
  }

  private async start(preRoll?: Int16Array[]): Promise<void> {
    const turn = ++this.turn;
    // Talking over JARVIS: it stops mid-sentence and listens.
    if (this.deps.speech?.busy) this.deps.speech.interrupt();
    this.clearReply();
    this.deps.timing?.start(preRoll ? "wake" : "ptt");
    this.stateNow = "listening";
    this.deps.publish({ type: "card.dismiss", id: TRANSCRIPT_CARD_ID });
    this.started = false;
    this.stopSoon = false;
    if (this.listening) await this.listening;
    if (turn !== this.turn) return;
    let result: ListenResult;
    const run = this.deps.listen({ keepThinking: true, ...(preRoll ? { preRoll } : {}) });
    this.started = true;
    if (this.stopSoon) this.deps.stop();
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.listening = settled;
    void settled.then(() => {
      if (this.listening === settled) this.listening = undefined;
    });
    try {
      result = await run;
    } catch (err) {
      if (turn !== this.turn) return;
      this.deps.timing?.cancel();
      console.error("voice:", err);
      this.card(voiceErrorCard(err, this.now()));
      this.stateNow = "idle";
      return;
    }
    if (turn !== this.turn) return;
    const text = result.text.trim();
    if (!text) {
      this.deps.timing?.cancel();
      if (result.reason !== "cancelled") this.card(missedCard(result, this.deps.hint(), this.now()));
      this.stateNow = "idle";
      return;
    }
    // The orb stays thinking (keepThinking) while JARVIS works on it.
    this.deps.publish({ type: "voice.transcript", text, final: true });
    this.stateNow = "thinking";
    this.asked = text;
    if (result.speechEndAt !== undefined)
      this.deps.timing?.heard({
        speechEndAt: result.speechEndAt,
        endpointMs: result.endpointMs ?? 0,
        speechMs: result.speechMs ?? 0,
      });
    this.deps.timing?.sent();
    let messageId: string;
    try {
      ({ messageId } = await this.deps.chat(text));
    } catch (err) {
      if (turn !== this.turn) return;
      this.deps.timing?.cancel();
      this.card(voiceErrorCard(err, this.now(), "Couldn't reach JARVIS"));
      this.finish();
      return;
    }
    if (turn !== this.turn || (this.stateNow !== "thinking" && this.stateNow !== "replying")) return;
    this.messageId ??= messageId;
    this.deps.timing?.accepted(messageId);
    if (this.finished.has(this.messageId)) return this.replied();
    this.finished.clear();
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timeout = set(() => this.finish(), REPLY_TIMEOUT_MS);
  }

  private cancel(): void {
    this.turn++;
    this.deps.timing?.cancel();
    this.deps.cancel();
    this.stateNow = "idle";
  }

  /** The reply has streamed to its end: done now, or once the speaker has said all of it. */
  private replied(): void {
    const speech = this.deps.speech;
    if (!speech?.busy) return this.finish();
    const turn = this.turn;
    this.clearReply();
    this.stateNow = "replying";
    void speech.drained().then(() => {
      // The speaker rests the orb itself; a new press (turn) or an interrupt has moved on already.
      if (turn === this.turn && this.stateNow === "replying") this.finish(false);
    });
  }

  /** The reply is done (or failed): the orb rests. */
  private finish(rest = true): void {
    this.clearReply();
    this.stateNow = "idle";
    if (rest) this.deps.publish({ type: "orb.state", state: "idle" });
  }

  private clearReply(): void {
    if (this.timeout !== undefined)
      (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timeout);
    this.timeout = undefined;
    this.asked = undefined;
    this.messageId = undefined;
    this.finished.clear();
  }

  private card(card: ScreenCard): void {
    this.deps.publish({ type: "card.show", card });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
