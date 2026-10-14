// Small JSON files under DATA_DIR, one per feature, so features don't share (and collide on) one
// state file. Writes are atomic (temp file + rename) and queued, so concurrent updates never
// interleave and a crash mid-write leaves the previous file intact.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class JsonFile<T extends object> {
  readonly path: string;
  private value: T;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, name: string, defaults: T) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, `${name}.json`);
    this.value = { ...defaults, ...JsonFile.read<T>(this.path) };
  }

  private static read<T>(path: string): Partial<T> {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Partial<T>;
    } catch {
      return {};
    }
  }

  get(): T {
    return this.value;
  }

  /** Applies `change` to the current value and saves. Resolves once this write is on disk. */
  update(change: (current: T) => T): Promise<void> {
    this.value = change(this.value);
    const snapshot = JSON.stringify(this.value, null, 2);
    this.chain = this.chain.then(() => this.write(snapshot)).catch((err) => console.error(`saving ${this.path}:`, err));
    return this.chain;
  }

  /** Synchronous write (used by the queue; exposed for tests that simulate a crash). */
  protected write(text: string): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.path);
  }
}
