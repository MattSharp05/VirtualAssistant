// Text to speech in the container (ADR 0005): reply text → speakable plain text (no markdown, links
// or emoji; at most MAX_SPOKEN_CHARS) → Piper WAV with the British male voice → ffmpeg OGG/Opus
// 48 kHz mono, which Telegram shows as a voice note. No network, no key.
// PIPER_BIN / PIPER_MODEL / FFMPEG_BIN override the paths (tests use fakes).

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 60_000;
/** Longer replies are spoken up to here; the rest stays text-only. */
export const MAX_SPOKEN_CHARS = 1000;

export interface TtsOptions {
  piperBin?: string;
  model?: string;
  ffmpegBin?: string;
  timeoutMs?: number;
}

function run(bin: string, args: string[], timeoutMs: number, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin.split("/").pop()} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
    // A binary that dies before reading stdin (EPIPE) is reported by its exit status above.
    child.stdin?.on("error", () => {});
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** Cut at the last sentence end before `max` (or the last space), so speech doesn't stop mid-word. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (sentence > max / 2) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(" ");
  return (space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:]+$/, "") + "…";
}

/** What gets read aloud: the reply without markdown, links, code or emoji, capped in length. */
export function speakable(markdown: string, max = MAX_SPOKEN_CHARS): string {
  const lines = markdown
    .replace(/```[\s\S]*?(```|$)/g, "\n") // code blocks aren't worth hearing
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/<(https?:\/\/[^>]+)>/g, "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "") // bare URLs
    .replace(/<\/?[a-z][^>]*>/gi, "") // stray HTML tags
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(#{1,6}|>+)\s*/, "") // headings, quotes
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "") // list markers
        .replace(/^\s*(?:[-*_]\s*){3,}$/, "") // horizontal rules
        .replace(/\|/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    // Each line is its own sentence, so a list is read with pauses, not run together.
    .map((line) => (/[.!?…:;,]$/.test(line) ? line : `${line}.`));
  return cap(lines.join(" ").replace(/\s+([.,!?;:])/g, "$1").trim(), max);
}

/** Speaks the text with Piper and returns an OGG/Opus voice note. Throws if there is nothing to say. */
export async function synthesize(text: string, opts: TtsOptions = {}): Promise<Buffer> {
  const piper = opts.piperBin ?? process.env.PIPER_BIN ?? "piper";
  const model = opts.model ?? process.env.PIPER_MODEL ?? "/opt/piper/voices/en_GB-alan-medium.onnx";
  const ffmpeg = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? "ffmpeg";
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const spoken = speakable(text);
  if (!spoken) throw new Error("nothing to say");
  const dir = await mkdtemp(join(tmpdir(), "jarvis-tts-"));
  const wav = join(dir, "reply.wav");
  const ogg = join(dir, "reply.ogg");
  try {
    // Piper reads the text on stdin and writes one WAV.
    await run(piper, ["--model", model, "--output_file", wav], timeout, spoken);
    await run(ffmpeg, ["-y", "-loglevel", "error", "-i", wav, "-ar", "48000", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", ogg], timeout);
    return await readFile(ogg);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
