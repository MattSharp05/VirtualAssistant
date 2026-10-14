// Speech to text in the container (ADR 0005): OGG/Opus (Telegram voice) or any audio → 16 kHz mono
// WAV with ffmpeg → whisper.cpp's whisper-cli with the English base model → text. No network, no key.
// WHISPER_BIN / WHISPER_MODEL / FFMPEG_BIN override the paths (tests use fakes).

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";

const TIMEOUT_MS = 60_000;

export interface SttOptions {
  whisperBin?: string;
  model?: string;
  ffmpegBin?: string;
  timeoutMs?: number;
}

export interface Transcript {
  text: string;
  ms: number;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin.split("/").pop()} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

/** whisper-cli's output without timestamps or markers like [BLANK_AUDIO] / (music). */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function transcribe(audioPath: string, opts: SttOptions = {}): Promise<Transcript> {
  const started = Date.now();
  const whisper = opts.whisperBin ?? process.env.WHISPER_BIN ?? "whisper-cli";
  const model = opts.model ?? process.env.WHISPER_MODEL ?? "/opt/whisper/ggml-base.en.bin";
  const ffmpeg = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? "ffmpeg";
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const wav = `${audioPath}.wav`;
  try {
    await run(ffmpeg, ["-y", "-loglevel", "error", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], timeout);
    // -nt: no timestamps, -np: only the transcript on stdout.
    const out = await run(whisper, ["-m", model, "-f", wav, "-l", "en", "-nt", "-np"], timeout);
    return { text: cleanTranscript(out), ms: Date.now() - started };
  } finally {
    await rm(wav, { force: true });
  }
}
