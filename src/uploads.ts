// Files Matthew hands JARVIS (Telegram documents/photos, Desk drops, screenshots; ADR 0009), saved
// under <dataDir>/uploads/<id>/<safe name>. The brain's only built-in tool is Read, allowed for this
// folder alone (src/tools/uploads.ts). Uploads older than 7 days are deleted daily.

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { JarvisError } from "./jarvis.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60_000;
const ALLOWED = new Set([".pdf", ".txt", ".md", ".markdown", ".csv", ".json", ".log", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface Upload {
  id: string;
  /** Absolute path the brain reads. */
  path: string;
  name: string;
}

export class UploadTooLarge extends JarvisError {}

/** A file name that can't climb out of its folder or surprise a shell: letters, digits, . _ - and spaces. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, "/"))
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(-100);
  return base || "file";
}

export function uploadsDir(dataDir: string): string {
  return resolve(dataDir, "uploads");
}

export class UploadStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = uploadsDir(dataDir);
    mkdirSync(this.dir, { recursive: true });
  }

  save(name: string, data: Uint8Array): Upload {
    if (data.byteLength > MAX_UPLOAD_BYTES) throw new UploadTooLarge(`Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    const clean = safeName(name);
    const ext = extname(clean).toLowerCase();
    if (!ALLOWED.has(ext)) throw new JarvisError(`I can read PDFs, text, markdown, CSV/JSON and images (png, jpg, gif, webp), not ${ext || "files without an extension"}.`);
    const id = randomBytes(6).toString("hex");
    const folder = join(this.dir, id);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, clean);
    writeFileSync(path, data);
    return { id, path, name: clean };
  }

  /** An earlier upload by id (the Desk sends ids with a chat message). */
  get(id: string): Upload | undefined {
    if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
    try {
      const [name] = readdirSync(join(this.dir, id));
      return name ? { id, path: join(this.dir, id, name), name } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Deletes upload folders older than 7 days; returns how many. */
  cleanup(now = Date.now(), maxAgeMs = UPLOAD_TTL_MS): number {
    let removed = 0;
    for (const id of readdirSync(this.dir)) {
      const folder = join(this.dir, id);
      try {
        if (now - statSync(folder).mtimeMs > maxAgeMs) {
          rmSync(folder, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // already gone
      }
    }
    return removed;
  }
}
