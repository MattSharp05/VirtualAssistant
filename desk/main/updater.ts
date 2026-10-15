// The in-app updater (ADR 0010). The app is unsigned, so Squirrel can't update it silently; instead, on
// launch and every 24 h (when Settings → Check for updates is on), this asks GitHub for the newest
// `desk-v*` release and, if it's newer than the running app, puts up a notice and a tray item. Updating
// downloads the release's .dmg into Downloads with a progress card, opens it and quits, so Matthew drags
// the new JARVIS Desk over the old one. No Electron in here: index.ts passes the app's pieces in, and
// the tests use a fake fetch.
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DeskEvent, ScreenCard } from "@jarvis/shared";

/** Every Desk release is tagged desk-vX.Y.Z (release.yml); the repo is public, so no token. */
export const RELEASES_URL = "https://api.github.com/repos/MattSharp05/VirtualAssistant/releases?per_page=30";
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** The launch check waits for the overlay to load, so its notice has somewhere to show. */
export const FIRST_CHECK_DELAY_MS = 15_000;
export const UPDATE_CARD_ID = "desk-update";

/** The fields of GitHub's release object the updater reads. */
export interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: { name: string; size: number; browser_download_url: string }[];
}

export interface AvailableUpdate {
  version: string;
  /** The release page (also the notice's Update button, with INSTALL_HASH). */
  pageUrl: string;
  dmgName: string;
  dmgUrl: string;
  bytes: number;
}

type Version = [number, number, number];

/** "1.2.10" or "v1.2.10" → [1, 2, 10]; a prerelease ("1.3.0-rc.1") or anything else → undefined. */
export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** A release tag's version: desk-v1.2.10 → [1, 2, 10]; other tags (the server's, prereleases) → undefined. */
export function deskTagVersion(tag: string): Version | undefined {
  return tag.startsWith("desk-v") ? parseVersion(tag.slice("desk-v".length)) : undefined;
}

/**
 * Compares the running app's version with a release's: negative when `a` is older. The app's own
 * version may carry a prerelease suffix (a CI build is 0.0.0-ci.N), which ranks below its X.Y.Z.
 */
export function compareVersions(a: string, b: string): number {
  const core = (v: string) => {
    const [main = "", pre] = v.replace(/^v/, "").split(/-(.*)/s);
    const parts = main.split(".").map((n) => Number(n) || 0);
    return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre: pre !== undefined };
  };
  const x = core(a);
  const y = core(b);
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i]! - y.parts[i]!;
  return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

/** The newest published desk release with a .dmg, if it's newer than `current`. */
export function newerRelease(releases: GithubRelease[], current: string): AvailableUpdate | undefined {
  let best: { version: Version; release: GithubRelease; dmg: GithubRelease["assets"][number] } | undefined;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = deskTagVersion(release.tag_name);
    const dmg = release.assets?.find((a) => a.name.toLowerCase().endsWith(".dmg"));
    if (!version || !dmg) continue;
    if (!best || compareVersions(version.join("."), best.version.join(".")) > 0)
      best = { version, release, dmg };
  }
  if (!best || compareVersions(current, best.version.join(".")) >= 0) return undefined;
  return {
    version: best.version.join("."),
    pageUrl: best.release.html_url,
    dmgName: best.dmg.name.replace(/[/\\]/g, "_"),
    dmgUrl: best.dmg.browser_download_url,
    bytes: best.dmg.size,
  };
}

/** The notice's Update button opens this URL; the overlay hands it to the updater instead of a browser. */
export const INSTALL_HASH = "#jarvis-desk-install";

export interface UpdaterOptions {
  /** app.getVersion(). */
  currentVersion: string;
  /** Settings → Check for updates. */
  enabled(): boolean;
  /** Where the .dmg goes: app.getPath("downloads"). */
  downloadsDir: string;
  /** Cards and notices, like the server's (main's broadcast). */
  publish(event: DeskEvent): void;
  /** shell.openPath: mounts the .dmg and shows its Finder window. Resolves to an error message, or "". */
  openPath(path: string): Promise<string>;
  quit(): void;
  /** The tray re-reads `state` (a new version found, download progress). */
  onChange?(): void;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface UpdaterState {
  available?: AvailableUpdate;
  /** 0–1 while the .dmg downloads. */
  downloading?: number;
  checking: boolean;
}

export class Updater {
  private available?: AvailableUpdate;
  private downloading?: number;
  private checking = false;
  /** Background checks tell Matthew about a version once; a forced check always answers. */
  private notified?: string;
  private first?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: UpdaterOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  get state(): UpdaterState {
    return {
      ...(this.available ? { available: this.available } : {}),
      ...(this.downloading !== undefined ? { downloading: this.downloading } : {}),
      checking: this.checking,
    };
  }

  /** Checks shortly after launch and then every 24 h; each check skips itself while the setting is off. */
  start(firstDelayMs = FIRST_CHECK_DELAY_MS): void {
    const tick = () => {
      if (this.opts.enabled()) void this.check();
    };
    this.first = setTimeout(tick, firstDelayMs);
    this.timer = setInterval(tick, CHECK_EVERY_MS);
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /**
   * Asks GitHub for a newer release. A background check is silent unless it finds one (once per
   * version); a forced one (tray → Check for updates) also says "up to date" or why it couldn't check.
   */
  async check(opts: { forced?: boolean } = {}): Promise<AvailableUpdate | undefined> {
    const forced = opts.forced ?? false;
    if (this.checking) return this.available;
    this.checking = true;
    this.opts.onChange?.();
    try {
      const res = await this.fetch(RELEASES_URL, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "JARVIS-Desk" },
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const releases = (await res.json()) as GithubRelease[];
      if (!Array.isArray(releases)) throw new Error("GitHub sent something other than a release list");
      this.available = newerRelease(releases, this.opts.currentVersion);
      if (this.available && (forced || this.notified !== this.available.version)) {
        this.notified = this.available.version;
        this.publishAvailable(this.available);
      } else if (!this.available && forced) {
        this.notice(
          "info",
          "JARVIS Desk is up to date",
          `You have the latest version, ${this.opts.currentVersion}.`,
        );
      }
      return this.available;
    } catch (err) {
      if (forced) this.notice("warn", "Couldn't check for updates", message(err));
      else console.warn("update check:", message(err));
      return undefined;
    } finally {
      this.checking = false;
      this.opts.onChange?.();
    }
  }

  /** Whether a link from a card is the notice's Update button (overlay.ts asks before opening a browser). */
  isInstallLink(url: string): boolean {
    return url.endsWith(INSTALL_HASH);
  }

  /**
   * Downloads the .dmg into Downloads with a progress card, opens it, and quits so the app can be
   * replaced. Errors go on the card (Matthew asked for this one).
   */
  async install(): Promise<void> {
    const update = this.available;
    if (!update || this.downloading !== undefined) return;
    const dest = join(this.opts.downloadsDir, update.dmgName);
    const part = `${dest}.part`;
    this.progress(update, 0);
    try {
      const res = await this.fetch(update.dmgUrl, { headers: { "User-Agent": "JARVIS-Desk" } });
      if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status})`);
      const total = Number(res.headers.get("content-length")) || update.bytes;
      let done = 0;
      let lastPct = 0;
      const count = new Transform({
        transform: (chunk: Buffer, _enc, next) => {
          done += chunk.length;
          const pct = total ? Math.floor((done / total) * 100) : 0;
          // A card per whole percent, not per chunk.
          if (pct !== lastPct) {
            lastPct = pct;
            this.progress(update, Math.min(1, done / total));
          }
          next(null, chunk);
        },
      });
      await mkdir(this.opts.downloadsDir, { recursive: true });
      await pipeline(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        count,
        createWriteStream(part),
      );
      if (total && done !== total) throw new Error(`The download stopped early (${done} of ${total} bytes)`);
      await rename(part, dest);
      this.card(update, "Opening the new version…", readyBody(update));
      const failed = await this.opts.openPath(dest);
      if (failed) throw new Error(`Couldn't open ${update.dmgName}: ${failed}`);
      this.opts.quit();
    } catch (err) {
      await rm(part, { force: true }).catch(() => {});
      this.downloading = undefined;
      this.opts.onChange?.();
      this.card(update, "Update didn't download", `${message(err)}. Try again from the menu-bar icon.`);
    }
  }

  private publishAvailable(update: AvailableUpdate) {
    this.notice(
      "info",
      `JARVIS Desk ${update.version} is out`,
      `Update downloads it to Downloads and opens it; JARVIS then quits so you can drag the new JARVIS Desk onto the one in Applications (Replace).`,
      [{ label: `Update to v${update.version}…`, url: `${update.pageUrl}${INSTALL_HASH}` }],
    );
  }

  private progress(update: AvailableUpdate, fraction: number) {
    this.downloading = fraction;
    this.opts.onChange?.();
    const mb = (b: number) => Math.round(b / 1_000_000);
    this.card(
      update,
      `Downloading JARVIS Desk ${update.version}`,
      `**${Math.floor(fraction * 100)}%** of ${mb(update.bytes)} MB, into Downloads. When it opens, JARVIS quits: drag JARVIS Desk onto Applications and choose Replace.`,
    );
  }

  private card(update: AvailableUpdate, title: string, body: string) {
    const card: ScreenCard = {
      id: UPDATE_CARD_ID,
      createdAt: this.now().toISOString(),
      title,
      body,
      kind: "text",
      link: { label: "Release notes", url: update.pageUrl },
    };
    this.opts.publish({ type: "card.show", card });
  }

  private notice(
    level: "info" | "warn",
    title: string,
    body: string,
    actions?: { label: string; url: string }[],
  ) {
    this.opts.publish({
      type: "notice",
      at: this.now().toISOString(),
      level,
      title,
      body,
      ...(actions ? { actions } : {}),
    });
  }
}

/** The card's last words before the app quits. */
export function readyBody(update: AvailableUpdate): string {
  return `${update.dmgName} is in Downloads. In its window, drag **JARVIS Desk** onto **Applications** and choose **Replace**, then open JARVIS Desk again.`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
