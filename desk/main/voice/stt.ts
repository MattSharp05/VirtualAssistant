// Speech to text on the Mac (ADR 0004): whisper.cpp's `whisper-cli` (an arm64 Metal build that CI
// compiles and bundles in the app's Resources) with the downloaded `ggml-base.en.bin`. The utterance
// is written as a 16 kHz mono WAV to a temp file and transcribed in one run; ~0.3 s for a short one.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 16-bit PCM mono as a WAV file. */
export function encodeWav(pcm: Int16Array, sampleRate = 16_000): Buffer {
  const data = pcm.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

/** `-nt` plain text, `-np` nothing but the text, English, a few CPU threads beside Metal. */
export function whisperArgs(model: string, wav: string, threads = 4): string[] {
  return ["-m", model, "-f", wav, "-l", "en", "-nt", "-np", "-t", String(threads)];
}

/** Whisper's stdout as one line; non-speech tags like [BLANK_AUDIO] or (wind blowing) dropped. */
export function parseWhisperOutput(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) =>
      line
        .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join(" ")
    .trim();
}

export interface WhisperLocation {
  /** process.resourcesPath in the packaged app. */
  resourcesPath?: string;
  /** The desk/ folder when running unpackaged (`npm start`), where CI or a developer puts vendor/whisper. */
  appDir?: string;
  env?: Record<string, string | undefined>;
}

/** Where whisper-cli may be, in order: JARVIS_WHISPER_CLI, the app bundle, desk/vendor/whisper. */
export function whisperCandidates({ resourcesPath, appDir, env = {} }: WhisperLocation): string[] {
  return [
    env.JARVIS_WHISPER_CLI,
    resourcesPath && join(resourcesPath, "whisper", "whisper-cli"),
    appDir && join(appDir, "vendor", "whisper", "whisper-cli"),
  ].filter((p): p is string => !!p);
}

export function findWhisper(where: WhisperLocation, exists: (p: string) => boolean = existsSync): string {
  const found = whisperCandidates(where).find(exists);
  if (!found) throw new Error("whisper-cli isn't in this build of JARVIS Desk, so it can't transcribe.");
  return found;
}

export type Spawn = typeof nodeSpawn;

export interface SttOptions {
  binary: string;
  model: string;
  spawn?: Spawn;
  timeoutMs?: number;
}

/** Transcribes one utterance; "" when Whisper heard nothing it could write down. */
export async function transcribe(audio: Int16Array, opts: SttOptions): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-stt-"));
  const wav = join(dir, "utterance.wav");
  try {
    await writeFile(wav, encodeWav(audio));
    const stdout = await run(opts, whisperArgs(opts.model, wav));
    return parseWhisperOutput(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(opts: SttOptions, args: string[]): Promise<string> {
  const spawn = opts.spawn ?? nodeSpawn;
  return new Promise((resolve, reject) => {
    const child = spawn(opts.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else {
        const last = err.trim().split("\n").pop() ?? "";
        reject(new Error(`whisper-cli failed (${signal ?? `exit ${code}`})${last ? `: ${last}` : ""}`));
      }
    });
  });
}
