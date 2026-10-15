// Spoken replies (JD-38, ADR 0004): JARVIS answers out loud with a built-in Mac voice, starting at the
// first sentence. Speaker follows the brain's events: a turn on the desk-voice channel (a question
// asked by voice, and the morning brief it brings or the Today window plays) is split into sentences
// as it streams (sentences.ts); typed turns and Telegram aren't spoken, nor anything while Settings →
// speakReplies is off. Each sentence is synthesised to an AIFF file (`say -o`) and played (`afplay`),
// the next one synthesised while the current one plays; while a sentence plays the orb gets
// orb.state speaking { amplitude } 30 times a second from the file's loudness (aiff.ts), and idle once
// the last one ends. interrupt() (⌥⌥ while it talks) stops at once and drops everything queued, and
// the rest of that reply. For voice latency (JD-48) it reports each reply's first sentence, its `say`
// file being ready and the first afplay (onMark); a reply's first sentence may be just its first clause
// when it runs long (FIRST_CLAUSE_CHARS), and prewarm() runs a throwaway `say` while Matthew is still
// talking, so the voice is loaded before the first real sentence. The processes are injected: tested
// with a fake say and afplay.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskEvent } from "@jarvis/shared";
import { envelope, ENVELOPE_HZ, parseAiff } from "./aiff";
import { SentenceSplitter } from "./sentences";
import type { SpeechStage } from "../latency";

/** A running `say` or `afplay`: done when it exits (rejects when it fails); stop() kills it. */
export interface SpeechProcess {
  done: Promise<void>;
  stop(): void;
}

export interface SpeakerDeps {
  /** `say -v <voice> -r <rate> -o <file> -- <text>`. */
  synthesize(text: string, file: string): SpeechProcess;
  /** `afplay <file>`. */
  play(file: string): SpeechProcess;
  /** The file's loudness per 1/30 s, 0–1 ([] when it can't be read). */
  envelope(file: string): Promise<number[]>;
  /** Deletes a sentence's file (played, or dropped). */
  remove(file: string): void;
  /** A temp file for the n-th sentence. */
  file(n: number): string;
  /** Settings → speakReplies. */
  speakReplies(): boolean;
  publish(event: DeskEvent): void;
  /** Voice latency (JD-48): a reply's first sentence, its file written, and its first sound. */
  onMark?(stage: SpeechStage, messageId: string): void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Sentences synthesised ahead of playback: the one playing and the next. */
export const SYNTH_AHEAD = 2;
/** A reply's first sentence still going at this many characters is spoken from its last comma (JD-48). */
export const FIRST_CLAUSE_CHARS = 80;
/** prewarm() does nothing when `say` ran this recently (its voice is still loaded). */
export const PREWARM_EVERY_MS = 60_000;

interface Sentence {
  text: string;
  file: string;
  state: "waiting" | "synthesising" | "ready";
  envelope: number[];
  process?: SpeechProcess;
  dropped?: boolean;
  /** The reply whose first sentence this is (JD-48's marks). */
  firstOf?: string;
}

export class Speaker {
  /** Sentences not yet played to the end; the first may be playing. */
  private queue: Sentence[] = [];
  /** Spoken replies still streaming, by messageId. */
  private replies = new Map<string, SentenceSplitter>();
  private playing?: { sentence: Sentence; process: SpeechProcess; ticker: unknown };
  private synthesising = false;
  private count = 0;
  /** Whether anything has played since the orb last rested (so a reply with nothing to say stays quiet). */
  private spoke = false;
  private waiters: (() => void)[] = [];
  /** When `say` last ran (a sentence or a prewarm), on `now`'s clock. */
  private lastSay = -Infinity;

  constructor(private readonly deps: SpeakerDeps) {}

  /** Something is queued, playing, or a spoken reply is still streaming. */
  get busy(): boolean {
    return this.replies.size > 0 || this.queue.length > 0;
  }

  /** Resolves once everything has been said (or interrupted). */
  drained(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** The brain's events (from the server, before the push-to-talk controller sees them). */
  onEvent(e: DeskEvent): void {
    if (e.type === "brain.start") {
      if (e.channel === "desk-voice" && this.deps.speakReplies())
        this.replies.set(e.messageId, new SentenceSplitter({ firstClauseChars: FIRST_CLAUSE_CHARS }));
    } else if (e.type === "brain.delta") {
      const splitter = this.replies.get(e.messageId);
      if (splitter) this.sayAll(splitter, splitter.push(e.text), e.messageId);
    } else if (e.type === "brain.done" || e.type === "brain.error") {
      const splitter = this.replies.get(e.messageId);
      if (!splitter) return;
      this.replies.delete(e.messageId);
      this.sayAll(splitter, splitter.flush(), e.messageId);
      this.settle();
    }
  }

  /** Queues a reply's sentences; the very first one is marked for JD-48. */
  private sayAll(splitter: SentenceSplitter, sentences: string[], messageId: string): void {
    sentences.forEach((s, i) => {
      const first = i === 0 && splitter.said === sentences.length;
      if (first) this.deps.onMark?.("firstSentence", messageId);
      this.say(s, first ? messageId : undefined);
    });
  }

  /** Queues one sentence. */
  say(text: string, firstOf?: string): void {
    this.queue.push({
      text,
      file: this.deps.file(++this.count),
      state: "waiting",
      envelope: [],
      ...(firstOf ? { firstOf } : {}),
    });
    this.pump();
  }

  /**
   * Runs `say` once into a throwaway file so the voice is loaded before the first sentence (JD-48;
   * push-to-talk calls it when listening starts). Skipped while talking or when `say` ran recently.
   */
  prewarm(): void {
    const now = (this.deps.now ?? (() => performance.now()))();
    if (this.busy || this.synthesising || now - this.lastSay < PREWARM_EVERY_MS) return;
    this.lastSay = now;
    const file = this.deps.file(0);
    this.deps
      .synthesize("Ready.", file)
      .done.catch(() => {})
      .finally(() => this.deps.remove(file));
  }

  /** Stops talking now: the sentence playing, everything queued, and the rest of the replies streaming. */
  interrupt(): void {
    this.replies.clear();
    if (this.playing) this.clearTicker(this.playing.ticker);
    this.playing = undefined;
    for (const s of this.queue) {
      s.dropped = true;
      s.process?.stop();
      this.deps.remove(s.file);
    }
    this.queue = [];
    this.synthesising = false;
    this.spoke = false; // listening follows; the orb doesn't rest in between
    this.settle();
  }

  private pump(): void {
    const head = this.queue[0];
    if (!this.playing && head?.state === "ready") this.play(head);
    if (!this.synthesising) {
      const next = this.queue.slice(0, SYNTH_AHEAD).find((s) => s.state === "waiting");
      if (next) this.synthesize(next);
    }
  }

  private synthesize(s: Sentence): void {
    s.state = "synthesising";
    this.synthesising = true;
    this.lastSay = (this.deps.now ?? (() => performance.now()))();
    const process = this.deps.synthesize(s.text, s.file);
    s.process = process;
    process.done
      .then(() => this.deps.envelope(s.file))
      .then(
        (envelope) => {
          s.envelope = envelope;
          s.state = "ready";
          if (s.firstOf && !s.dropped) this.deps.onMark?.("sayReady", s.firstOf);
        },
        (err: unknown) => {
          if (s.dropped) return;
          console.warn("say:", err instanceof Error ? err.message : err);
          this.drop(s);
        },
      )
      .finally(() => {
        if (s.dropped) return;
        s.process = undefined;
        this.synthesising = false;
        this.pump();
        this.settle();
      });
  }

  private play(s: Sentence): void {
    const process = this.deps.play(s.file);
    s.process = process;
    if (s.firstOf) this.deps.onMark?.("audioStart", s.firstOf);
    const now = this.deps.now ?? (() => performance.now());
    const startedAt = now();
    const tick = () => {
      const frame = Math.floor(((now() - startedAt) * ENVELOPE_HZ) / 1000);
      this.deps.publish({ type: "orb.state", state: "speaking", amplitude: s.envelope[frame] ?? 0 });
    };
    tick();
    const every = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.playing = { sentence: s, process, ticker: every(tick, 1000 / ENVELOPE_HZ) };
    this.spoke = true;
    process.done
      .catch((err: unknown) => console.warn("afplay:", err instanceof Error ? err.message : err))
      .then(() => {
        if (s.dropped || this.playing?.sentence !== s) return;
        this.clearTicker(this.playing.ticker);
        this.playing = undefined;
        this.drop(s);
        // Between sentences (or while the next is still being written) the orb holds still.
        if (this.queue.length) this.deps.publish({ type: "orb.state", state: "speaking", amplitude: 0 });
        this.pump();
        this.settle();
      });
  }

  private drop(s: Sentence): void {
    this.deps.remove(s.file);
    this.queue = this.queue.filter((q) => q !== s);
  }

  /** Nothing left to say: the orb rests and whoever waits on drained() goes on. */
  private settle(): void {
    if (this.busy) return;
    if (this.spoke) this.deps.publish({ type: "orb.state", state: "idle" });
    this.spoke = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private clearTicker(handle: unknown): void {
    (this.deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(handle);
  }
}

// ── The real thing: macOS `say` and `afplay` ──

export interface MacSpeakerOptions {
  /** Settings → voice and speechRate, read for every sentence. */
  voice(): string;
  rate(): number;
  speakReplies(): boolean;
  publish(event: DeskEvent): void;
  onMark?(stage: SpeechStage, messageId: string): void;
}

export function createMacSpeaker(opts: MacSpeakerOptions): Speaker {
  let dir: string | undefined;
  return new Speaker({
    synthesize: (text, file) => sayTo(text, file, opts.voice(), opts.rate()),
    play: (file) => run("afplay", [file]),
    envelope: async (file) => {
      try {
        const pcm = parseAiff(await readFile(file));
        return pcm ? envelope(pcm) : [];
      } catch {
        return [];
      }
    },
    remove: (file) => void rm(file, { force: true }).catch(() => {}),
    file: (n) => join((dir ??= mkdtempSync(join(tmpdir(), "jarvis-say-"))), `${n}.aiff`),
    speakReplies: opts.speakReplies,
    publish: opts.publish,
    ...(opts.onMark ? { onMark: opts.onMark } : {}),
  });
}

/** `say` to a file; a voice this Mac doesn't have (any more) falls back to the system voice. */
function sayTo(text: string, file: string, voice: string, rate: number): SpeechProcess {
  const args = (v?: string) => [
    ...(v ? ["-v", v] : []),
    "-r",
    String(Math.round(rate)),
    "-o",
    file,
    "--",
    text,
  ];
  let current = run("say", args(voice));
  let stopped = false;
  const done = current.done.catch((err: Error) => {
    if (stopped || !voice) throw err;
    console.warn(`say: voice "${voice}" failed (${err.message}); using the system voice`);
    current = run("say", args());
    return current.done;
  });
  return {
    done,
    stop() {
      stopped = true;
      current.stop();
    },
  };
}

function run(command: string, args: string[]): SpeechProcess {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => void (stderr = (stderr + d.toString()).slice(-500)));
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${signal ?? `exited with ${code}`} ${stderr.trim()}`.trim())),
    );
  });
  return { done, stop: () => void child.kill() };
}
