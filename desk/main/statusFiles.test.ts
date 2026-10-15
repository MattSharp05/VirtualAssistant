// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusFiles } from "./settingsSchema";
import {
  NoStatusFolderError,
  StatusFileWriter,
  TEST_STEP_MS,
  WAVE_HZ,
  WAVE_SAMPLES,
  type StatusFs,
} from "./statusFiles";

/** An in-memory file system that records each write (only renames count as a file appearing). */
function fakeFs() {
  const tmp = new Map<string, string>();
  const files = new Map<string, string>();
  const writes: { path: string; data: string }[] = [];
  const fs: StatusFs = {
    mkdir: async () => {},
    writeFile: async (path, data) => void tmp.set(path, data),
    rename: async (from, to) => {
      const data = tmp.get(from)!;
      tmp.delete(from);
      files.set(to, data);
      writes.push({ path: to, data });
    },
  };
  return { fs, files, writes, tmp };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const json = (s: string | undefined) => JSON.parse(s ?? "null");

describe("StatusFileWriter", () => {
  let dirs: StatusFiles;
  let disk: ReturnType<typeof fakeFs>;
  let writer: StatusFileWriter;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_760_000_000_000 });
    dirs = { barehandsDir: "/bh/state", visualizerDir: "/viz" };
    disk = fakeFs();
    writer = new StatusFileWriter({ dirs: () => dirs, fs: disk.fs });
  });
  afterEach(() => {
    writer.stop();
    vi.useRealTimers();
  });

  it("writes each state to barehands' state file and the visualizer's .voice_state", async () => {
    for (const state of ["listening", "thinking", "speaking", "idle"] as const) {
      writer.onEvent({ type: "orb.state", state });
      await flush();
      expect(disk.files.get("/bh/state/state")).toBe(state);
      expect(disk.files.get("/viz/.voice_state")).toBe(state);
    }
    expect(disk.tmp.size).toBe(0);
  });

  it("writes the state only when it changes", async () => {
    writer.onEvent({ type: "orb.state", state: "listening", amplitude: 0.2 });
    writer.onEvent({ type: "orb.state", state: "listening", amplitude: 0.4 });
    await flush();
    writer.onEvent({ type: "orb.state", state: "listening", amplitude: 0.3 });
    await flush();
    expect(disk.writes.filter((w) => w.path === "/bh/state/state")).toHaveLength(1);
    // Listening carries the mic level, not the speaker's: no wave.
    expect(disk.files.has("/bh/state/wave.json")).toBe(false);
  });

  it("writes mood.json { mood, ts } to barehands only", async () => {
    writer.onEvent({ type: "mood.changed", mood: "amber", reason: "a session needs you" });
    await flush();
    expect(json(disk.files.get("/bh/state/mood.json"))).toEqual({ mood: "amber", ts: 1_760_000_000 });
    expect([...disk.files.keys()].some((p) => p.startsWith("/viz/"))).toBe(false);
  });

  it("while speaking writes 64 amplitude samples to wave.json and .voice_waveform", async () => {
    writer.onEvent({ type: "orb.state", state: "speaking", amplitude: 0.5 });
    await flush();
    const wave = json(disk.files.get("/bh/state/wave.json"));
    expect(wave.samples).toHaveLength(WAVE_SAMPLES);
    expect(wave.samples.at(-1)).toBe(0.5);
    expect(wave.samples[0]).toBe(0);
    expect(wave.ts).toBe(1_760_000_000);
    expect(disk.files.get("/viz/.voice_waveform")).toBe(disk.files.get("/bh/state/wave.json"));
    // Out-of-range amplitudes are clamped to 0–1.
    await vi.advanceTimersByTimeAsync(1000);
    writer.onEvent({ type: "orb.state", state: "speaking", amplitude: 3 });
    await flush();
    expect(json(disk.files.get("/bh/state/wave.json")).samples.slice(-2)).toEqual([0.5, 1]);
  });

  it("throttles wave writes to 15 Hz, keeping the newest samples", async () => {
    // 60 amplitude updates a second for one second.
    for (let i = 0; i < 60; i++) {
      writer.onEvent({ type: "orb.state", state: "speaking", amplitude: (i % 10) / 10 });
      await vi.advanceTimersByTimeAsync(1000 / 60);
    }
    await vi.advanceTimersByTimeAsync(100);
    const waves = disk.writes.filter((w) => w.path === "/bh/state/wave.json");
    expect(waves.length).toBeGreaterThanOrEqual(WAVE_HZ - 1);
    expect(waves.length).toBeLessThanOrEqual(WAVE_HZ + 1);
    const gaps = waves.slice(1).map((w, i) => json(w.data).ts - json(waves[i].data).ts);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1 / WAVE_HZ - 0.002);
    // The last write has every sample, the newest last.
    expect(json(waves.at(-1)!.data).samples.slice(-3)).toEqual([0.7, 0.8, 0.9]);
  });

  it("flattens the wave when speaking ends", async () => {
    writer.onEvent({ type: "orb.state", state: "speaking", amplitude: 0.8 });
    await vi.advanceTimersByTimeAsync(10);
    writer.onEvent({ type: "orb.state", state: "speaking", amplitude: 0.6 });
    writer.onEvent({ type: "orb.state", state: "idle" });
    await vi.advanceTimersByTimeAsync(200);
    expect(json(disk.files.get("/bh/state/wave.json")).samples).toEqual(Array(WAVE_SAMPLES).fill(0));
    expect(disk.files.get("/bh/state/state")).toBe("idle");
  });

  it("writes nothing without folders, and a newly chosen folder gets the current state", async () => {
    dirs = {};
    writer.onEvent({ type: "orb.state", state: "thinking" });
    writer.onEvent({ type: "mood.changed", mood: "green", reason: "" });
    await flush();
    expect(disk.writes).toEqual([]);
    dirs = { barehandsDir: "/new" };
    writer.refresh();
    await flush();
    expect(disk.files.get("/new/state")).toBe("thinking");
    expect(json(disk.files.get("/new/mood.json")).mood).toBe("green");
  });

  it("Test cycles the four states, then goes back to the real one", async () => {
    writer.onEvent({ type: "orb.state", state: "thinking" });
    await flush();
    const done = writer.test();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await flush();
      seen.push(disk.files.get("/bh/state/state")!);
      expect(disk.files.get("/viz/.voice_state")).toBe(seen.at(-1));
      await vi.advanceTimersByTimeAsync(TEST_STEP_MS);
    }
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(seen).toEqual(["idle", "listening", "thinking", "speaking"]);
    const waves = disk.writes.filter((w) => w.path === "/bh/state/wave.json");
    expect(waves.length).toBeGreaterThan(15);
    expect(json(waves[3].data).samples.some((s: number) => s > 0)).toBe(true);
    expect(disk.files.get("/bh/state/state")).toBe("thinking");
    expect(json(disk.files.get("/bh/state/wave.json")).samples).toEqual(Array(WAVE_SAMPLES).fill(0));
  });

  it("Test needs a folder", async () => {
    dirs = {};
    await expect(writer.test()).rejects.toBeInstanceOf(NoStatusFolderError);
  });

  it("a failed write is retried on the next change and doesn't throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const rename = disk.fs.rename;
    disk.fs.rename = async (from, to) => {
      if (fail) throw new Error("EACCES");
      return rename(from, to);
    };
    writer.onEvent({ type: "orb.state", state: "listening" });
    await flush();
    fail = false;
    writer.refresh();
    await flush();
    expect(disk.files.get("/bh/state/state")).toBe("listening");
    expect(warn).toHaveBeenCalledTimes(2); // once per file (barehands + visualizer)
    warn.mockRestore();
  });
});

describe("StatusFileWriter on disk", () => {
  it("writes atomically: only the final files are left, with the right names", async () => {
    const root = mkdtempSync(join(tmpdir(), "status-files-"));
    const dirs = { barehandsDir: join(root, "barehands", "state"), visualizerDir: join(root, "viz") };
    const writer = new StatusFileWriter({ dirs: () => dirs });
    writer.onEvent({ type: "mood.changed", mood: "red", reason: "server down" });
    writer.onEvent({ type: "orb.state", state: "speaking", amplitude: 0.25 });
    await vi.waitFor(() => expect(existsSync(join(dirs.visualizerDir, ".voice_waveform"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    writer.stop();
    expect(readdirSync(dirs.barehandsDir).sort()).toEqual(["mood.json", "state", "wave.json"]);
    expect(readdirSync(dirs.visualizerDir).sort()).toEqual([".voice_state", ".voice_waveform"]);
    expect(readFileSync(join(dirs.barehandsDir, "state"), "utf8")).toBe("speaking");
    expect(JSON.parse(readFileSync(join(dirs.barehandsDir, "mood.json"), "utf8")).mood).toBe("red");
    expect(JSON.parse(readFileSync(join(dirs.visualizerDir, ".voice_waveform"), "utf8")).samples.at(-1)).toBe(
      0.25,
    );
  });
});
