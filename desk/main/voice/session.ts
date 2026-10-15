// One turn of listening (ADR 0004): open the mic, run each frame through the VAD and the endpointer
// until Matthew stops talking, then transcribe. States: idle → listening → transcribing → idle. The
// orb hears about it from here (orb.state listening with the mic level, then thinking), published
// locally so it reacts at once, without a round trip to the server. Push-to-talk (JD-31) and the
// wake word (JD-43) both call listen(). Dependencies are injected: tested with fakes.
import type { DeskEvent } from "@jarvis/shared";
import type { Mic } from "../audio/recorder";
import { Endpointer, type EndpointerOptions, type EndReason } from "./endpointer";
import type { Vad } from "./vad";

export type VoiceState = "idle" | "preparing" | "listening" | "transcribing";

export interface ListenResult {
  /** "" when nothing was said (or nothing Whisper could write down), or when it was cancelled. */
  text: string;
  /** How long transcription took after Matthew stopped talking. */
  ms: number;
  reason: EndReason | "cancelled";
  /** When Matthew stopped talking (the last speech frame; `now`'s clock), for JD-48's latency. */
  speechEndAt?: number;
  /** How long after that the end was decided (the endpointer's silence wait, or the key's release). */
  endpointMs?: number;
  /** How long he spoke. */
  speechMs?: number;
}

/** What listen() needs once the models are on disk. */
export interface VoiceEngine {
  vad: Vad;
  transcribe(audio: Int16Array): Promise<string>;
}

export interface VoiceSessionDeps {
  /** Loads the models (downloading them the first time) and the VAD; called once, then reused. */
  prepare(): Promise<VoiceEngine>;
  openMic(): Promise<Mic>;
  publish(event: DeskEvent): void;
  /** Wall clock in ms (Date.now): ListenResult's speechEndAt is on it. */
  now?: () => number;
  /** Overrides, read at every listen (Settings → endpointSilenceMs, JD-48). */
  endpointer?: Partial<EndpointerOptions> | (() => Partial<EndpointerOptions>);
}

export interface ListenOptions {
  /** Leave the orb on "thinking" afterwards (JD-31 hands over to the server's reply); default idle. */
  keepThinking?: boolean;
  /** Frames heard just before listening began (the wake word's last 500 ms, JD-43), run first. */
  preRoll?: Int16Array[];
}

export class VoiceSession {
  private stateNow: VoiceState = "idle";
  private engine?: Promise<VoiceEngine>;
  private current?: Promise<ListenResult>;
  private stopRequested = false;
  private cancelled = false;

  constructor(private readonly deps: VoiceSessionDeps) {}

  get state(): VoiceState {
    return this.stateNow;
  }

  /** Listens for one utterance. A second call while one is running gets the same result. */
  listen(opts: ListenOptions = {}): Promise<ListenResult> {
    this.current ??= this.run(opts).finally(() => {
      this.current = undefined;
      this.stateNow = "idle";
    });
    return this.current;
  }

  /** Ends the current listen early (what was said so far is still transcribed). */
  stop(): void {
    if (this.stateNow === "listening" || this.stateNow === "preparing") this.stopRequested = true;
  }

  /** Ends the current listen and throws away what was said (push-to-talk's second double-tap). */
  cancel(): void {
    if (this.stateNow === "idle") return;
    this.cancelled = true;
    this.stopRequested = true;
  }

  /** Loads the models now (first run: downloads them) so the first listen() starts at once. */
  warmUp(): Promise<void> {
    return this.ready().then(() => undefined);
  }

  private ready(): Promise<VoiceEngine> {
    this.engine ??= this.deps.prepare().catch((err) => {
      this.engine = undefined; // try again next time (e.g. after the network comes back)
      throw err;
    });
    return this.engine;
  }

  private orb(state: "idle" | "listening" | "thinking", amplitude?: number): void {
    this.deps.publish({ type: "orb.state", state, ...(amplitude === undefined ? {} : { amplitude }) });
  }

  private async run(opts: ListenOptions): Promise<ListenResult> {
    const now = this.deps.now ?? Date.now;
    this.stopRequested = false;
    this.cancelled = false;
    this.stateNow = "preparing";
    let engine: VoiceEngine;
    try {
      engine = await this.ready();
    } catch (err) {
      this.orb("idle");
      throw err;
    }
    if (this.cancelled) {
      this.orb("idle");
      return { text: "", ms: 0, reason: "cancelled" };
    }
    let mic: Mic;
    try {
      mic = await this.deps.openMic();
    } catch (err) {
      this.orb("idle");
      throw err;
    }
    this.stateNow = "listening";
    this.orb("listening", 0);
    const tuning = this.deps.endpointer;
    const endpointer = new Endpointer(typeof tuning === "function" ? tuning() : tuning);
    engine.vad.reset();
    let audio: Int16Array | undefined;
    let reason: EndReason;
    let silenceMs: number;
    let speechMs: number;
    const preRoll = [...(opts.preRoll ?? [])];
    try {
      outer: for (;;) {
        const frame = preRoll.shift() ?? (await mic.read());
        const p = await engine.vad.probability(frame);
        for (const e of endpointer.push(frame, p)) {
          if (e.type === "level") this.orb("listening", e.level);
          if (e.type === "end") {
            ({ audio, reason, silenceMs, speechMs } = e);
            break outer;
          }
        }
        if (this.stopRequested) {
          ({ audio, reason, silenceMs } = endpointer.flush());
          speechMs = audio ? Math.round((audio.length * 1000) / endpointer.opts.sampleRate) : 0;
          break;
        }
      }
    } catch (err) {
      this.orb("idle");
      throw err;
    } finally {
      mic.stop();
    }

    if (this.cancelled || !audio) {
      this.orb("idle");
      return { text: "", ms: 0, reason: this.cancelled ? "cancelled" : reason };
    }
    this.stateNow = "transcribing";
    this.orb("thinking");
    const started = now();
    // The frames arrive in real time, so the last speech frame was `silenceMs` of audio ago.
    const timing = { speechEndAt: started - silenceMs, endpointMs: silenceMs, speechMs };
    try {
      const text = await engine.transcribe(audio);
      // Cancelled while Whisper was busy: the words are dropped, not sent.
      if (this.cancelled) {
        this.orb("idle");
        return { text: "", ms: now() - started, reason: "cancelled" };
      }
      if (!opts.keepThinking || !text) this.orb("idle");
      return { text, ms: now() - started, reason, ...timing };
    } catch (err) {
      this.orb("idle");
      throw err;
    }
  }
}
