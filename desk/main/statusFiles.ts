// Status files for the faces that run beside JARVIS Desk (JD-45): barehands' board and ai-visualizer
// stay separate apps (ADR 0012) that read small files, and main keeps those files current from the
// orb's states. Settings → Faces & status files picks the folders:
//   barehandsDir (its state/ folder): `state` (idle|listening|thinking|speaking), `mood.json`
//     { mood, ts } and, while speaking, `wave.json` { samples: [64 floats], ts }.
//   visualizerDir: `.voice_state` and `.voice_waveform`, the same formats under backtalk's names.
// Writes are atomic (temp file + rename), the state is written only when it changes and the wave at
// most 15 times a second. ts is Unix seconds. Plain Node: tested with a fake file system and clock.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeskEvent, Mood, OrbState } from "@jarvis/shared";
import type { StatusFiles } from "./settingsSchema";

export const WAVE_SAMPLES = 64;
export const WAVE_HZ = 15;
/** How long each state shows during Settings → Test. */
export const TEST_STEP_MS = 1500;
export const TEST_STATES: readonly OrbState[] = ["idle", "listening", "thinking", "speaking"];

/** File names per folder kind. */
export const STATUS_FILES = {
  barehands: { state: "state", mood: "mood.json", wave: "wave.json" },
  visualizer: { state: ".voice_state", wave: ".voice_waveform" },
} as const;

export interface StatusFs {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const nodeFs: StatusFs = {
  mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  rename: (from, to) => rename(from, to),
};

export interface StatusFilesOptions {
  /** Settings → statusFiles, read on every write so a new folder applies at once. */
  dirs(): StatusFiles;
  fs?: StatusFs;
  /** Milliseconds, like Date.now. */
  now?: () => number;
}

export class NoStatusFolderError extends Error {
  constructor() {
    super("Choose a barehands or visualizer folder first.");
  }
}

/** Contents of a wave file: the last 64 amplitudes (0–1), oldest first. */
export const waveJson = (samples: readonly number[], ts: number) =>
  JSON.stringify({ samples: samples.map((s) => Math.round(s * 1000) / 1000), ts });

export class StatusFileWriter {
  private readonly fs: StatusFs;
  private readonly now: () => number;
  private state: OrbState = "idle";
  private mood: Mood | undefined;
  private samples: number[] = Array<number>(WAVE_SAMPLES).fill(0);
  /** What each file last got (or is getting), so nothing is rewritten unchanged. */
  private readonly written = new Map<string, string>();
  /** Per file: the content waiting behind the write in flight (latest wins, writes never reorder). */
  private readonly queued = new Map<string, string>();
  private readonly busy = new Set<string>();
  private lastWave = -Infinity;
  private waveTimer: ReturnType<typeof setTimeout> | undefined;
  private testing: Promise<void> | undefined;
  private tmpCount = 0;
  private readonly warned = new Set<string>();

  constructor(private readonly opts: StatusFilesOptions) {
    this.fs = opts.fs ?? nodeFs;
    this.now = opts.now ?? Date.now;
  }

  /** Every event main broadcasts goes through here; only orb.state and mood.changed matter. */
  onEvent(event: DeskEvent): void {
    if (event.type === "orb.state") this.setState(event.state, event.amplitude);
    else if (event.type === "mood.changed") this.setMood(event.mood);
  }

  setState(state: OrbState, amplitude?: number): void {
    const was = this.state;
    this.state = state;
    if (state === "speaking" && amplitude !== undefined) this.pushSample(amplitude);
    if (this.testing) return;
    if (state !== was) {
      this.writeState();
      // A face mustn't keep showing the last wave after JARVIS stops talking.
      if (was === "speaking") this.flatWave();
    }
    if (state === "speaking") this.scheduleWave();
  }

  setMood(mood: Mood): void {
    this.mood = mood;
    if (!this.testing) this.writeMood();
  }

  /** Writes everything for the current folders, e.g. after one is chosen in Settings. */
  refresh(): void {
    if (this.testing) return;
    this.writeState();
    this.writeMood();
  }

  /**
   * Settings → Test: shows each of the four states for 1.5 s (speaking with a made-up wave), then
   * goes back to the real state. Throws when no folder is set.
   */
  test(): Promise<void> {
    const dirs = this.opts.dirs();
    if (!dirs.barehandsDir && !dirs.visualizerDir) return Promise.reject(new NoStatusFolderError());
    this.testing ??= this.runTest().finally(() => {
      this.testing = undefined;
      this.refresh();
      if (this.state !== "speaking") this.flatWave();
    });
    return this.testing;
  }

  stop(): void {
    clearTimeout(this.waveTimer);
    this.waveTimer = undefined;
  }

  // ── internals ──

  private async runTest(): Promise<void> {
    for (const state of TEST_STATES) {
      this.writeFiles("state", state);
      if (state !== "speaking") {
        await sleep(TEST_STEP_MS);
        continue;
      }
      const start = this.now();
      for (let t = 0; t < TEST_STEP_MS; t += 1000 / WAVE_HZ) {
        const phase = (this.now() - start) / 1000;
        const samples = Array.from(
          { length: WAVE_SAMPLES },
          (_, i) => 0.5 + 0.45 * Math.sin(i / 4 + phase * 9) * Math.sin(phase * 3 + i / 20),
        );
        this.writeFiles("wave", waveJson(samples, this.ts()));
        await sleep(1000 / WAVE_HZ);
      }
      this.writeFiles("wave", waveJson(Array<number>(WAVE_SAMPLES).fill(0), this.ts()));
    }
  }

  private pushSample(amplitude: number): void {
    const a = Number.isFinite(amplitude) ? Math.min(1, Math.max(0, amplitude)) : 0;
    this.samples.push(a);
    this.samples.splice(0, this.samples.length - WAVE_SAMPLES);
  }

  /** At most WAVE_HZ wave writes a second: now if the last was long enough ago, else at the next slot. */
  private scheduleWave(): void {
    if (this.waveTimer) return;
    const wait = this.lastWave + 1000 / WAVE_HZ - this.now();
    if (wait <= 0) return this.writeWave();
    this.waveTimer = setTimeout(() => {
      this.waveTimer = undefined;
      if (this.state === "speaking" && !this.testing) this.writeWave();
    }, wait);
  }

  private writeWave(): void {
    this.lastWave = this.now();
    this.writeFiles("wave", waveJson(this.samples, this.ts()));
  }

  private flatWave(): void {
    this.stop();
    this.samples = Array<number>(WAVE_SAMPLES).fill(0);
    this.writeFiles("wave", waveJson(this.samples, this.ts()));
  }

  private writeState(): void {
    this.writeFiles("state", this.state);
  }

  private writeMood(): void {
    if (this.mood) this.writeFiles("mood", JSON.stringify({ mood: this.mood, ts: this.ts() }));
  }

  private ts(): number {
    return Math.round(this.now()) / 1000;
  }

  /** One kind of file into every folder that has it. The state file is skipped when unchanged. */
  private writeFiles(kind: "state" | "mood" | "wave", data: string): void {
    const dirs = this.opts.dirs();
    const targets: string[] = [];
    if (dirs.barehandsDir) targets.push(join(dirs.barehandsDir, STATUS_FILES.barehands[kind]));
    if (dirs.visualizerDir && kind !== "mood")
      targets.push(join(dirs.visualizerDir, STATUS_FILES.visualizer[kind]));
    for (const path of targets) {
      if (kind === "state" && this.written.get(path) === data) continue;
      this.written.set(path, data);
      this.enqueue(path, data);
    }
  }

  private enqueue(path: string, data: string): void {
    this.queued.set(path, data);
    if (!this.busy.has(path)) void this.drain(path);
  }

  private async drain(path: string): Promise<void> {
    this.busy.add(path);
    try {
      for (let data = this.queued.get(path); data !== undefined; data = this.queued.get(path)) {
        this.queued.delete(path);
        try {
          await this.writeAtomic(path, data);
        } catch (err) {
          // Forget it so the next change tries again; say so once per file, not 15 times a second.
          this.written.delete(path);
          if (!this.warned.has(path)) console.warn(`status file ${path}:`, err);
          this.warned.add(path);
        }
      }
    } finally {
      this.busy.delete(path);
    }
  }

  private async writeAtomic(path: string, data: string): Promise<void> {
    await this.fs.mkdir(dirname(path));
    const tmp = `${path}.${process.pid}.${++this.tmpCount}.tmp`;
    await this.fs.writeFile(tmp, data);
    await this.fs.rename(tmp, path);
    this.warned.delete(path);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
