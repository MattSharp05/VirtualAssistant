// desk.log (JD-63): what went wrong, where Matthew (and Claude) can read it afterwards. Main writes
// renderer console errors and warnings, uncaught errors and rejections (they reach the console too),
// crashed renderers, failed preloads and page loads, from every window, plus main's own uncaught
// errors, to ~/Library/Logs/JARVIS Desk/desk.log. At 5 MB it moves to desk.log.1 (one old file kept).
// No Electron in here, so it's tested on a temp folder; index.ts wires it to the windows.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type LogLevel = "error" | "warn" | "info";

export interface DeskLog {
  readonly file: string;
  /** One line: time, level, where from (main, overlay, settings…) and the message. */
  write(level: LogLevel, source: string, message: string): void;
}

export interface LogOptions {
  file: string;
  maxBytes?: number;
  now?: () => Date;
}

/** One log line; newlines inside the message are kept readable but indented. */
export function logLine(at: Date, level: LogLevel, source: string, message: string): string {
  const text = message.replace(/\s+$/, "").replace(/\n/g, "\n    ");
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${text}\n`;
}

export function createLog({ file, maxBytes = MAX_LOG_BYTES, now = () => new Date() }: LogOptions): DeskLog {
  let ready = false;
  return {
    file,
    write(level, source, message) {
      try {
        if (!ready) {
          mkdirSync(dirname(file), { recursive: true });
          ready = true;
        }
        const line = logLine(now(), level, source, message);
        let size = 0;
        try {
          size = statSync(file).size;
        } catch {
          // no log yet
        }
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`);
        appendFileSync(file, line);
      } catch (err) {
        // The log must never take the app down with it.
        console.error("desk.log:", err);
      }
    },
  };
}

/** Which window a page is, from its URL's hash ("…index.html#/overlay" → "overlay"). */
export function windowSource(url: string): string {
  const hash = /#\/?([a-z0-9-]+)/i.exec(url)?.[1];
  return hash ?? (url.startsWith("http") ? "web" : "window");
}

/** An Error (or anything thrown) as text, with its stack when there is one. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return typeof err === "string" ? err : (JSON.stringify(err) ?? String(err));
}
