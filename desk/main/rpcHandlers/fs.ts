// Folder access (JD-41, ADR 0009): the server's mac_list / mac_read tools arrive here as `rpc` events
// "fs.list" and "fs.read". Only paths inside Settings → Folders are answered, checked after symlinks
// are resolved (so a link pointing out of a folder is refused); hidden files and folders are skipped,
// files are text, PDF or images up to 2 MB, and a listing stops at 200 entries. Read-only: nothing
// here writes. No Electron in here, so it's tested on real temp folders.
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import {
  FS_MAX_FILE_BYTES,
  FS_MAX_LIST_ENTRIES,
  type FsEntry,
  type FsListRequest,
  type FsListResult,
  type FsReadRequest,
  type FsReadResult,
} from "@jarvis/shared";

/** The same kinds the server's uploads take (src/uploads.ts). */
export const READABLE = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);
const MAX_DEPTH = 6;

/** A refusal with a message JARVIS can pass on as is. */
export class FsRefused extends Error {}

export interface FsOptions {
  /** Settings → Folders, read on every call so a removed folder is refused at once. */
  allowedFolders(): string[];
  home?: string;
}

const isHidden = (name: string) => name.startsWith(".");
const mb = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** "*trip*.md" → a case-insensitive whole-name RegExp. */
export function patternToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i");
}

const inside = (root: string, path: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export class MacFiles {
  private readonly home: string;

  constructor(private readonly opts: FsOptions) {
    this.home = opts.home ?? homedir();
  }

  /** The allowed folders as real paths (ones that no longer exist are left out). */
  private async roots(): Promise<string[]> {
    const out: string[] = [];
    for (const folder of this.opts.allowedFolders()) {
      try {
        out.push(await realpath(folder));
      } catch {
        // moved or deleted since it was added
      }
    }
    return out;
  }

  /**
   * The real path of `input` and the allowed folder it's in. Refuses relative paths, `..`, anything
   * that resolves (symlinks included) outside every allowed folder, and hidden files or folders.
   */
  async resolve(input: unknown): Promise<{ path: string; root: string }> {
    if (typeof input !== "string" || !input.trim()) throw new FsRefused("Give a full path on the Mac.");
    let path = input.trim();
    if (path === "~" || path.startsWith("~/")) path = join(this.home, path.slice(1));
    if (!isAbsolute(path))
      throw new FsRefused(`"${input}" isn't a full path; use one inside an allowed folder.`);
    if (path.split(/[\\/]+/).includes(".."))
      throw new FsRefused(`"${input}" climbs out with "..", which isn't allowed.`);
    const roots = await this.roots();
    if (!roots.length)
      throw new FsRefused("No folders are allowed yet; Matthew adds them in Settings → Folders.");
    let real: string;
    try {
      real = await realpath(normalize(path));
    } catch {
      throw new FsRefused(`There's no ${path} on the Mac.`);
    }
    const root = roots.find((r) => inside(r, real));
    if (!root)
      throw new FsRefused(
        `${path} is outside the folders JARVIS may read (${this.opts.allowedFolders().join(", ")}).`,
      );
    if (relative(root, real).split(sep).some(isHidden))
      throw new FsRefused(`${path} is hidden, so JARVIS doesn't read it.`);
    return { path: real, root };
  }

  async list(req: FsListRequest = {}): Promise<FsListResult> {
    if (req.folder === undefined || req.folder === "") {
      const entries: FsEntry[] = [];
      for (const folder of this.opts.allowedFolders()) entries.push({ path: folder, type: "folder" });
      return { entries, truncated: false };
    }
    const { path, root } = await this.resolve(req.folder);
    if (!(await stat(path)).isDirectory())
      throw new FsRefused(`${req.folder} is a file; read it with fs.read.`);
    const match = req.pattern ? patternToRegExp(req.pattern) : undefined;
    const entries: FsEntry[] = [];
    let truncated = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      let names: string[];
      try {
        names = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
      } catch {
        return; // unreadable (permissions); leave it out
      }
      for (const name of names) {
        if (truncated) return;
        if (isHidden(name)) continue;
        let full = join(dir, name);
        try {
          if ((await lstat(full)).isSymbolicLink()) {
            // A link is listed only when it lands inside the same allowed folder.
            full = await realpath(full);
            if (!inside(root, full) || relative(root, full).split(sep).some(isHidden)) continue;
          }
          const info = await stat(full);
          const type = info.isDirectory() ? "folder" : info.isFile() ? "file" : undefined;
          if (!type) continue;
          if (!match || match.test(name)) {
            if (entries.length >= FS_MAX_LIST_ENTRIES) {
              truncated = true;
              return;
            }
            entries.push({
              path: join(dir, name),
              type,
              ...(type === "file" ? { size: info.size } : {}),
              modified: info.mtime.toISOString(),
            });
          }
          if (type === "folder" && depth < MAX_DEPTH) await walk(join(dir, name), depth + 1);
        } catch {
          // vanished or unreadable while listing
        }
      }
    };
    await walk(path, 0);
    return { folder: path, entries, truncated };
  }

  async read(req: FsReadRequest): Promise<FsReadResult> {
    const { path } = await this.resolve(req?.path);
    const info = await stat(path);
    if (info.isDirectory()) throw new FsRefused(`${req.path} is a folder; list it with fs.list.`);
    const ext = extname(path).toLowerCase();
    if (!READABLE.has(ext))
      throw new FsRefused(
        `JARVIS reads text, markdown, CSV/JSON, PDFs and images (png, jpg, gif, webp), not ${ext || "files without an extension"}.`,
      );
    if (info.size > FS_MAX_FILE_BYTES)
      throw new FsRefused(
        `${basename(path)} is ${mb(info.size)}; JARVIS reads files up to ${mb(FS_MAX_FILE_BYTES)}.`,
      );
    const data = await readFile(path);
    return { name: basename(path), size: data.byteLength, data: data.toString("base64") };
  }
}
