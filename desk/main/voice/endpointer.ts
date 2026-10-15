// When Matthew has stopped talking (ADR 0004): a state machine over 32 ms mic frames and the VAD's
// speech probability for each. An utterance starts once there has been 300 ms of speech (shorter
// blips, a cough or a keyboard clack, are dropped) and ends after 700 ms of non-speech, or at 30 s.
// Listening with no speech at all gives up after a while. It also turns the frames into a 0–1 level
// for the listening orb, 20 times a second of audio. Pure: no timers, time is counted in samples.

export interface EndpointerOptions {
  sampleRate: number;
  /** Probability at or above which a frame is speech. */
  threshold: number;
  /** Below this a frame is silence; in between, it continues whatever was happening (hysteresis). */
  negThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  /** The longest utterance, from its first speech frame. */
  maxMs: number;
  /** Give up when no utterance has started by then. */
  noSpeechMs: number;
  /** Audio kept from before the first speech frame, so the first word isn't clipped. */
  preRollMs: number;
  /** Silence kept after the last speech frame (the rest is trimmed before transcribing). */
  tailMs: number;
  levelHz: number;
}

export const ENDPOINTER_DEFAULTS: EndpointerOptions = {
  sampleRate: 16_000,
  threshold: 0.5,
  negThreshold: 0.35,
  silenceMs: 700,
  minSpeechMs: 300,
  maxMs: 30_000,
  noSpeechMs: 8_000,
  preRollMs: 300,
  tailMs: 250,
  levelHz: 20,
};

/** stopped: the caller ended listening early (flush). */
export type EndReason = "silence" | "max" | "no-speech" | "stopped";

export type EndpointerEvent =
  | { type: "level"; level: number }
  | { type: "start" }
  /**
   * audio: the utterance as 16-bit PCM (absent for no-speech); speechMs: frames that were speech;
   * silenceMs: the non-speech since the last speech frame, i.e. how long ago Matthew stopped (JD-48).
   */
  | { type: "end"; reason: EndReason; audio?: Int16Array; speechMs: number; silenceMs: number };

export type EndpointerState = "waiting" | "candidate" | "speaking" | "done";

/** A frame's loudness as 0–1: RMS in dBFS mapped from -55 dB (0) to -15 dB (1). */
export function frameLevel(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const s of frame) sum += s * s;
  const rms = Math.sqrt(sum / frame.length) / 32768;
  const db = 20 * Math.log10(Math.max(rms, 1e-9));
  return Math.min(1, Math.max(0, (db + 55) / 40));
}

export class Endpointer {
  readonly opts: EndpointerOptions;
  private stateNow: EndpointerState = "waiting";
  /** Samples seen since listening began. */
  private samples = 0;
  private preRoll: Int16Array[] = [];
  private utterance: Int16Array[] = [];
  /** Index in `utterance` just after the last speech frame. */
  private lastSpeechAt = 0;
  private speechSamples = 0;
  private silenceSamples = 0;
  private utteranceSamples = 0;
  private level = 0;
  private nextLevelAt = 0;

  constructor(opts: Partial<EndpointerOptions> = {}) {
    this.opts = { ...ENDPOINTER_DEFAULTS, ...opts };
  }

  get state(): EndpointerState {
    return this.stateNow;
  }

  private ms(samples: number): number {
    return (samples * 1000) / this.opts.sampleRate;
  }

  private preRollFrames(frameLength: number): number {
    return Math.ceil((this.opts.preRollMs * this.opts.sampleRate) / 1000 / frameLength);
  }

  /** Feeds one frame with its speech probability; returns what happened (often nothing). */
  push(frame: Int16Array, probability: number): EndpointerEvent[] {
    if (this.stateNow === "done") return [];
    const out: EndpointerEvent[] = [];
    this.samples += frame.length;

    // Fast attack, slower release, so the orb pulses with syllables without flickering.
    const now = frameLevel(frame);
    this.level = now > this.level ? now : this.level * 0.6 + now * 0.4;
    const step = this.opts.sampleRate / this.opts.levelHz;
    while (this.samples >= this.nextLevelAt + step) {
      this.nextLevelAt += step;
      out.push({ type: "level", level: Math.round(this.level * 1000) / 1000 });
    }

    const speech = probability >= this.opts.threshold;
    const silence = probability < this.opts.negThreshold;

    if (this.stateNow === "waiting") {
      if (speech) {
        this.stateNow = "candidate";
        this.utterance = [...this.preRoll, frame];
        this.utteranceSamples = frame.length;
        this.speechSamples = frame.length;
        this.silenceSamples = 0;
        this.lastSpeechAt = this.utterance.length;
      } else {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames(frame.length)) this.preRoll.shift();
      }
    } else {
      this.utterance.push(frame);
      this.utteranceSamples += frame.length;
      if (speech || (!silence && this.silenceSamples === 0)) {
        if (speech) this.speechSamples += frame.length;
        this.silenceSamples = 0;
        this.lastSpeechAt = this.utterance.length;
      } else {
        this.silenceSamples += frame.length;
      }
    }

    if (this.stateNow === "candidate") {
      if (this.ms(this.speechSamples) >= this.opts.minSpeechMs) {
        this.stateNow = "speaking";
        out.push({ type: "start" });
      } else if (this.ms(this.silenceSamples) >= this.opts.silenceMs) {
        // A blip, not an utterance: back to waiting, keeping its tail as pre-roll.
        this.stateNow = "waiting";
        this.preRoll = this.utterance.slice(-this.preRollFrames(frame.length));
        this.utterance = [];
      }
    }

    if (this.stateNow === "speaking") {
      if (this.ms(this.silenceSamples) >= this.opts.silenceMs) out.push(this.finish("silence"));
      else if (this.ms(this.utteranceSamples) >= this.opts.maxMs) out.push(this.finish("max"));
    } else if (this.stateNow === "waiting" && this.ms(this.samples) >= this.opts.noSpeechMs) {
      out.push(this.finish("no-speech"));
    }
    return out;
  }

  /** Ends now: the utterance so far if there was one (300 ms of speech), else no audio. */
  flush(): { reason: EndReason; audio?: Int16Array; silenceMs: number } {
    if (this.stateNow === "done") return { reason: "stopped", silenceMs: 0 };
    const spoke = this.stateNow === "speaking";
    const end = this.finish(spoke ? "stopped" : "no-speech");
    return { reason: end.reason, silenceMs: end.silenceMs, ...(end.audio ? { audio: end.audio } : {}) };
  }

  private finish(reason: EndReason): Extract<EndpointerEvent, { type: "end" }> {
    this.stateNow = "done";
    const speechMs = Math.round(this.ms(this.speechSamples));
    const silenceMs = Math.round(this.ms(this.silenceSamples));
    if (reason === "no-speech") return { type: "end", reason, speechMs: 0, silenceMs };
    const frameLen = this.utterance[0]?.length ?? 1;
    const tail = Math.ceil((this.opts.tailMs * this.opts.sampleRate) / 1000 / frameLen);
    const frames = this.utterance.slice(0, Math.min(this.utterance.length, this.lastSpeechAt + tail));
    const audio = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      audio.set(f, at);
      at += f.length;
    }
    return { type: "end", reason, audio, speechMs, silenceMs };
  }
}
