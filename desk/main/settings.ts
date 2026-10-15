// The Desk's settings (window bounds now; server, voice and hotkeys from JD-26): one JSON file in the
// app's userData folder, written a moment after the last change so dragging a window doesn't hammer
// the disk.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class Settings {
  private values: Record<string, unknown>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly file: string,
    private readonly delayMs = 500,
  ) {
    try {
      this.values = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      this.values = {};
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Writes pending changes now (on quit). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.values, null, 2));
  }
}
