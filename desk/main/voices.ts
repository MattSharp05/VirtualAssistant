// macOS voices for Settings → Voice: the list `say -v ?` prints, and a sample spoken with `say`. Only
// one sample speaks at a time.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { VoiceInfo } from "@jarvis/shared";

/**
 * `say -v ?` lines look like `Daniel              en_GB    # Hello! My name is Daniel.`; names can
 * have spaces and brackets ("Eddy (English (UK))").
 */
export function parseSayVoices(output: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#\s?(.*)$/.exec(line.trimEnd());
    if (m) voices.push({ name: m[1].trim(), locale: m[2], sample: m[3].trim() });
  }
  return voices;
}

export function listVoices(): Promise<VoiceInfo[]> {
  return new Promise((resolve) => {
    execFile("say", ["-v", "?"], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? [] : parseSayVoices(stdout)),
    );
  });
}

let speaking: ChildProcess | undefined;

/** Speaks `text` with `say`; resolves when it's done (or replaced by the next call). */
export function speak(text: string, voice: string, rate: number): Promise<void> {
  speaking?.kill();
  return new Promise((resolve) => {
    const child = spawn("say", ["-v", voice, "-r", String(Math.round(rate)), "--", text], {
      stdio: "ignore",
    });
    speaking = child;
    child.on("error", () => resolve());
    child.on("exit", () => {
      if (speaking === child) speaking = undefined;
      resolve();
    });
  });
}
