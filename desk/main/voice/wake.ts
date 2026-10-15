// The wake word "Jarvis" (JD-43, ADR 0004): Porcupine's built-in JARVIS keyword, on the Mac, over the
// same PvRecorder frames the endpointer uses (SharedMic: one holder at a time). While nothing else is
// happening it keeps the last 500 ms of audio; on a detection it hands that and the mic over to
// push-to-talk's pipeline (listen → chat → speak), so "Jarvis what's on today" in one breath is kept.
// It pauses while push-to-talk is busy or JARVIS is speaking (no self-triggering), when it's turned
// off, and during Do Not Disturb (unless wakeDuringDnd). Porcupine is a native module, loaded lazily
// and injected, so all of this tests with a fake engine.
import { FRAME_LENGTH, SAMPLE_RATE, type Mic } from "../audio/recorder";

/** Audio kept from before a detection, handed to the endpointer. */
export const PRE_ROLL_MS = 500;
export const PRE_ROLL_FRAMES = Math.ceil((PRE_ROLL_MS * SAMPLE_RATE) / 1000 / FRAME_LENGTH);

/** The parts of a Porcupine instance used here. */
export interface WakeEngine {
  readonly frameLength: number;
  /** The keyword's index when it ends in this frame, else -1. */
  process(frame: Int16Array): number;
  release(): void;
}

/** createEngine throws this when Picovoice doesn't accept the AccessKey. */
export class WakeKeyError extends Error {}

/**
 * off: turned off; no-key / bad-key: the AccessKey is missing or not accepted; paused: push-to-talk or
 * speech is busy, or Do Not Disturb; listening: hearing for "Jarvis"; error: the mic or engine failed.
 */
export type WakeStatus = "off" | "no-key" | "bad-key" | "paused" | "listening" | "error";

export interface WakeConfig {
  enabled: boolean;
  accessKey?: string;
  /** 0–1: higher misses less and false-triggers more. */
  sensitivity: number;
  dnd: boolean;
  /** Keep listening for "Jarvis" during Do Not Disturb. */
  wakeDuringDnd: boolean;
}

export interface WakeDeps {
  config(): WakeConfig;
  createEngine(accessKey: string, sensitivity: number): WakeEngine;
  /** A lease on the shared mic. */
  acquireMic(): Promise<Mic>;
  /** Push-to-talk isn't idle, or JARVIS is speaking. */
  busy(): boolean;
  /** "Jarvis": start listening with the audio just before. */
  onWake(preRoll: Int16Array[]): void;
  chime(): void;
  onStatus?(status: WakeStatus): void;
  now?: () => number;
}

export class WakeWord {
  private statusNow: WakeStatus = "off";
  private engine?: WakeEngine;
  private keyRejected = false;
  /** Bumped to stop the running loop. */
  private generation = 0;
  private running = false;
  private lastTriggerAt?: number;
  private active = false;

  constructor(private readonly deps: WakeDeps) {}

  get status(): WakeStatus {
    return this.statusNow;
  }

  /** When "Jarvis" was last heard (ms), for "That wasn't me". */
  get lastTrigger(): number | undefined {
    return this.lastTriggerAt;
  }

  /** Starts following the settings (main/index.ts, not on a scenario such as the smoke test). */
  start(): void {
    this.active = true;
    this.sync();
  }

  /** Re-checks whether to listen (settings, push-to-talk or speaking changed). */
  sync(): void {
    if (!this.active) return;
    const want = this.wanted();
    if (want !== "listening") {
      this.stopLoop();
      if (want === "off") this.releaseEngine();
      return this.setStatus(want);
    }
    if (!this.engine) {
      const { accessKey, sensitivity } = this.deps.config();
      try {
        this.engine = this.deps.createEngine(accessKey!, sensitivity);
        if (this.engine.frameLength !== FRAME_LENGTH)
          throw new Error(`Porcupine wants ${this.engine.frameLength}-sample frames, not ${FRAME_LENGTH}.`);
      } catch (err) {
        this.releaseEngine();
        if (err instanceof WakeKeyError) this.keyRejected = true;
        else console.error("wake word:", err);
        return this.setStatus(err instanceof WakeKeyError ? "bad-key" : "error");
      }
    }
    if (this.running) return this.setStatus("listening");
    void this.loop(this.engine);
  }

  /** The key, sensitivity or mic changed: start again from a new engine. */
  reload(): void {
    this.keyRejected = false;
    if (!this.active) return;
    this.stopLoop();
    this.releaseEngine();
    this.sync();
  }

  stop(): void {
    this.active = false;
    this.stopLoop();
    this.releaseEngine();
    this.setStatus("off");
  }

  private wanted(): WakeStatus {
    const c = this.deps.config();
    if (!c.enabled) return "off";
    if (!c.accessKey) return "no-key";
    if (this.keyRejected) return "bad-key";
    if ((c.dnd && !c.wakeDuringDnd) || this.deps.busy()) return "paused";
    return "listening";
  }

  private async loop(engine: WakeEngine): Promise<void> {
    const generation = ++this.generation;
    this.running = true;
    this.setStatus("listening");
    let mic: Mic | undefined;
    let handedOver = false;
    try {
      mic = await this.deps.acquireMic();
      const ring: Int16Array[] = [];
      while (generation === this.generation) {
        const frame = await mic.read();
        // Speaking or push-to-talk started since: never fed to Porcupine (no self-triggering).
        if (generation !== this.generation || this.deps.busy()) break;
        ring.push(frame);
        if (ring.length > PRE_ROLL_FRAMES) ring.shift();
        if (engine.process(frame) < 0) continue;
        this.lastTriggerAt = (this.deps.now ?? Date.now)();
        this.deps.chime();
        // The session takes the still-running mic over (push-to-talk goes busy, which pauses this).
        this.deps.onWake([...ring]);
        handedOver = this.deps.busy();
        break;
      }
    } catch (err) {
      // A read rejects when push-to-talk took the mic: that's a pause, not a failure.
      if (generation === this.generation && !this.deps.busy()) {
        console.error("wake word mic:", err);
        this.stopLoop();
        this.setStatus("error");
      }
    } finally {
      if (!handedOver) mic?.stop();
    }
    if (generation === this.generation) {
      this.running = false;
      this.sync();
    }
  }

  private stopLoop(): void {
    this.generation++;
    this.running = false;
  }

  private releaseEngine(): void {
    this.engine?.release();
    this.engine = undefined;
  }

  private setStatus(status: WakeStatus): void {
    if (status === this.statusNow) return;
    this.statusNow = status;
    this.deps.onStatus?.(status);
  }
}

/** The tray's status line for the wake word, or undefined when there's nothing to say. */
export function wakeStatusLine(status: WakeStatus): string | undefined {
  switch (status) {
    case "no-key":
    case "bad-key":
      return "Wake word: add Picovoice key in Settings";
    case "error":
      return "Wake word: unavailable (microphone or engine)";
    default:
      return undefined;
  }
}

/** One line of the false-trigger log ("That wasn't me"), kept for tuning the sensitivity. */
export function falseTriggerEntry(lastTrigger: number, reportedAt: number, sensitivity: number): string {
  return `${JSON.stringify({
    trigger: new Date(lastTrigger).toISOString(),
    reported: new Date(reportedAt).toISOString(),
    sensitivity,
  })}\n`;
}

/** The parts of @picovoice/porcupine-node used here. */
export interface PorcupineModule {
  Porcupine: new (
    accessKey: string,
    keywords: string[],
    sensitivities: number[],
    options?: { modelPath?: string; libraryPath?: string },
  ) => WakeEngine;
  BuiltinKeyword: { JARVIS: string };
  getBuiltinKeywordPath(keyword: string): string;
}

/** Native code can't read inside the asar: its files sit in app.asar.unpacked (electron-builder). */
export const unpacked = (path: string) => path.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");

/** Porcupine's own error classes, by name: the AccessKey-shaped ones become WakeKeyError. */
export function isKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.constructor.name;
  return (
    name.startsWith("PorcupineActivation") ||
    (name === "PorcupineInvalidArgumentError" && /access ?key/i.test(err.message))
  );
}

/** A Porcupine engine for the built-in JARVIS keyword (the module is required lazily; injectable). */
export function createPorcupine(accessKey: string, sensitivity: number, pv?: PorcupineModule): WakeEngine {
  // require, not import(): the bundle is CommonJS and the module sits in the (unpacked) asar.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = pv ?? (require("@picovoice/porcupine-node") as PorcupineModule);
  const keyword = unpacked(mod.getBuiltinKeywordPath(mod.BuiltinKeyword.JARVIS));
  // The model sits next to the keyword files: <package>/lib/common/porcupine_params.pv.
  const root = keyword.replace(/[\\/]resources[\\/]keyword_files[\\/].*$/, "");
  try {
    return new mod.Porcupine(accessKey, [keyword], [sensitivity], {
      modelPath: `${root}/lib/common/porcupine_params.pv`,
    });
  } catch (err) {
    if (isKeyError(err)) throw new WakeKeyError("Picovoice didn't accept the AccessKey.");
    throw err;
  }
}
