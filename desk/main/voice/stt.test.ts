// @vitest-environment node
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  encodeWav,
  findWhisper,
  parseWhisperOutput,
  transcribe,
  whisperArgs,
  whisperCandidates,
  type Spawn,
} from "./stt";

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit WAV", () => {
    const wav = encodeWav(Int16Array.from([0, 1000, -1000, 32767]));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(wav.length).toBe(52);
    expect(wav.readInt16LE(48)).toBe(-1000);
  });
});

describe("parseWhisperOutput", () => {
  it("joins lines and drops non-speech tags", () => {
    expect(parseWhisperOutput(" What's on my calendar\n tomorrow?\n")).toBe(
      "What's on my calendar tomorrow?",
    );
    expect(parseWhisperOutput("[BLANK_AUDIO]\n")).toBe("");
    expect(parseWhisperOutput(" (keyboard clicking) Remind me at 5.\n")).toBe("Remind me at 5.");
  });
});

describe("finding whisper-cli", () => {
  it("prefers the env override, then the app bundle, then desk/vendor", () => {
    const where = {
      resourcesPath: "/App/Resources",
      appDir: "/repo/desk",
      env: { JARVIS_WHISPER_CLI: "/opt/w" },
    };
    expect(whisperCandidates(where)).toEqual([
      "/opt/w",
      "/App/Resources/whisper/whisper-cli",
      "/repo/desk/vendor/whisper/whisper-cli",
    ]);
    expect(findWhisper(where, (p) => p.startsWith("/App"))).toBe("/App/Resources/whisper/whisper-cli");
    expect(() => findWhisper(where, () => false)).toThrow("whisper-cli isn't in this build");
  });
});

/** A fake whisper-cli: records its args and the WAV it was given, then prints `stdout`. */
function fakeSpawn(stdout: string, code = 0, stderr = "") {
  const calls: { bin: string; args: string[]; wav?: Buffer }[] = [];
  const spawn = ((bin: string, args: string[]) => {
    const wavPath = args[args.indexOf("-f") + 1];
    calls.push({ bin, args, wav: existsSync(wavPath) ? readFileSync(wavPath) : undefined });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", code, null);
    });
    return child;
  }) as unknown as Spawn;
  return { spawn, calls };
}

describe("transcribe", () => {
  it("runs whisper-cli on a temp WAV with the model, then cleans up", async () => {
    const { spawn, calls } = fakeSpawn(" What's on my calendar tomorrow?\n");
    const text = await transcribe(new Int16Array(1600), {
      binary: "/bin/whisper-cli",
      model: "/m/base.bin",
      spawn,
    });
    expect(text).toBe("What's on my calendar tomorrow?");
    expect(calls[0].bin).toBe("/bin/whisper-cli");
    expect(calls[0].args).toEqual(expect.arrayContaining(["-m", "/m/base.bin", "-l", "en", "-nt", "-np"]));
    expect(calls[0].wav!.length).toBe(44 + 3200);
    expect(existsSync(calls[0].args[calls[0].args.indexOf("-f") + 1])).toBe(false);
  });

  it("passes the latency tuning (JD-48): threads, and a beam size only when it isn't whisper's own", async () => {
    expect(whisperArgs("m", "w.wav")).toEqual([
      "-m",
      "m",
      "-f",
      "w.wav",
      "-l",
      "en",
      "-nt",
      "-np",
      "-t",
      "4",
    ]);
    expect(whisperArgs("m", "w.wav", { threads: 6, beamSize: 5 }).slice(-2)).toEqual(["-t", "6"]);
    expect(whisperArgs("m", "w.wav", { threads: 6, beamSize: 1 }).slice(-4)).toEqual(["-t", "6", "-bs", "1"]);
    const { spawn, calls } = fakeSpawn("ok\n");
    await transcribe(new Int16Array(10), { binary: "w", model: "m", spawn, tuning: { beamSize: 2 } });
    expect(calls[0].args.slice(-2)).toEqual(["-bs", "2"]);
  });

  it("fails with whisper's last error line", async () => {
    const { spawn } = fakeSpawn("", 3, "loading model\nerror: failed to open model\n");
    await expect(transcribe(new Int16Array(10), { binary: "w", model: "m", spawn })).rejects.toThrow(
      "whisper-cli failed (exit 3): error: failed to open model",
    );
  });
});
