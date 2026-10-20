// The in-app updater (ADR 0010). The app is unsigned, so Squirrel can't update it; instead, on launch
// and every 24 h (when Settings → Check for updates is on), this asks GitHub for the newest `desk-v*`
// release. If it's newer than the running app and carries latest-mac.json (JD-74), the zip downloads in
// the background into userData/updates/<version>/, is checked (sha256, version, signature) and offered
// as "Restart now / Later"; with Install updates automatically on, it also installs when the app quits.
// updateInstaller.ts swaps the app. Anything that stops that (the app on the disk image or in a folder
// it can't write to, a failed download or check) falls back to the old flow: the .dmg downloads into
// Downloads with a progress card, opens, and JARVIS quits so Matthew drags it over. No Electron in here:
// index.ts passes the app's pieces in, and the tests use a fake fetch and temp folders.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DeskEvent, NoticeAction, ScreenCard } from "@jarvis/shared";
import {
  helperScript,
  MANIFEST_NAME,
  parseManifest,
  run as runTool,
  selfUpdateBlocker,
  shouldInstallOnQuit,
  unpackUpdate,
  type Run,
  type UpdateManifest,
} from "./updateInstaller";

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
  /** latest-mac.json on the release (JD-74); releases before it have only the .dmg. */
  manifestUrl?: string;
}

/** A downloaded, verified update waiting for Restart now or a quit. */
export interface ReadyUpdate {
  version: string;
  pageUrl: string;
  /** The unpacked JARVIS Desk.app in userData/updates/<version>/. */
  app: string;
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
  const manifest = best.release.assets.find((a) => a.name === MANIFEST_NAME);
  return {
    version: best.version.join("."),
    pageUrl: best.release.html_url,
    dmgName: best.dmg.name.replace(/[/\\]/g, "_"),
    dmgUrl: best.dmg.browser_download_url,
    bytes: best.dmg.size,
    ...(manifest ? { manifestUrl: manifest.browser_download_url } : {}),
  };
}

/** The notice's Update button opens this URL; the overlay hands it to the updater instead of a browser. */
export const INSTALL_HASH = "#jarvis-desk-install";
/** The ready notice's Restart now button (JD-74), handed to the updater the same way. */
export const RESTART_HASH = "#jarvis-desk-restart";

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
  // Automatic updates (JD-74). Without updatesDir (and a writable appPath) every update uses the .dmg.
  /** userData/updates: downloads, the helper script, previous.app and the install markers. */
  updatesDir?: string;
  /** The installed JARVIS Desk.app (appBundlePath(process.execPath)); undefined when not packaged. */
  appPath?: string;
  /** Settings → Install updates automatically: install a downloaded update on quit. */
  autoInstall?(): boolean;
  /** desk.log's path, for the helper's own lines. */
  logFile?(): string;
  /** desk.log for the updater's steps and failures. */
  log?(level: "info" | "warn" | "error", message: string): void;
  pid?: number;
  /** Starts the helper script detached, so it outlives the app. */
  spawnHelper?(script: string): void;
  /** ditto, plutil, codesign (updateInstaller.run). */
  run?: Run;
  /** fs.access, for the writable-location check. */
  access?(path: string, mode: number): Promise<void>;
}

export interface UpdaterState {
  available?: AvailableUpdate;
  /** 0–1 while the .dmg (or, in the background, the zip) downloads. */
  downloading?: number;
  /** A downloaded update, ready for Restart to update. */
  ready?: string;
  checking: boolean;
}

/** What the helper leaves for the next launch: which version it installed, from which. */
interface PendingInstall {
  version: string;
  from: string;
  pageUrl: string;
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
  private ready?: ReadyUpdate;
  /** The background download and check of an update, while it runs. */
  private preparing?: Promise<void>;
  private helperStarted = false;
  /** A version whose install didn't take (rolled back): it gets the .dmg instead. */
  private failedVersion?: string;
  /** What launched() found, shown with the first check (once the overlay is up). */
  private announcement?: DeskEvent;

  constructor(private readonly opts: UpdaterOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  get state(): UpdaterState {
    return {
      ...(this.available ? { available: this.available } : {}),
      ...(this.downloading !== undefined ? { downloading: this.downloading } : {}),
      ...(this.ready ? { ready: this.ready.version } : {}),
      checking: this.checking,
    };
  }

  /**
   * On every launch, before anything else: if the helper just installed an update, tell it this
   * version started (so it doesn't roll back) and queue "Updated to <v>"; if it rolled back, say so
   * and use the .dmg for that version from now on.
   */
  launched(): void {
    const dir = this.opts.updatesDir;
    if (!dir) return;
    try {
      this.failedVersion = (
        JSON.parse(readFileSync(join(dir, "failed.json"), "utf8")) as { version?: string }
      ).version;
    } catch {
      // nothing failed
    }
    let pending: PendingInstall;
    try {
      pending = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as PendingInstall;
    } catch {
      return;
    }
    try {
      rmSync(join(dir, "pending.json"), { force: true });
      if (compareVersions(this.opts.currentVersion, pending.version) === 0) {
        writeFileSync(join(dir, `started-${pending.version}`), this.now().toISOString());
        rmSync(join(dir, pending.version), { recursive: true, force: true });
        this.log("info", `Updated from ${pending.from} to ${pending.version}`);
        this.announcement = {
          type: "card.show",
          card: {
            id: UPDATE_CARD_ID,
            createdAt: this.now().toISOString(),
            title: `Updated to ${pending.version}`,
            body: `JARVIS Desk installed **${pending.version}** by itself (you had ${pending.from}).`,
            kind: "text",
            link: { label: "Release notes", url: pending.pageUrl },
          },
        };
      } else {
        this.failedVersion = pending.version;
        writeFileSync(join(dir, "failed.json"), JSON.stringify({ version: pending.version }));
        this.log("warn", `${pending.version} wasn't installed; still on ${this.opts.currentVersion}`);
        this.announcement = {
          type: "notice",
          at: this.now().toISOString(),
          level: "warn",
          title: `JARVIS Desk ${pending.version} wasn't installed`,
          body: `JARVIS went back to ${this.opts.currentVersion}; desk.log says why. That version will use the download instead.`,
        };
      }
    } catch (err) {
      this.log("error", `After an update: ${message(err)}`);
    }
  }

  /** Checks shortly after launch and then every 24 h; each check skips itself while the setting is off. */
  start(firstDelayMs = FIRST_CHECK_DELAY_MS): void {
    const tick = () => {
      if (this.opts.enabled()) void this.check();
    };
    this.first = setTimeout(() => {
      if (this.announcement) this.opts.publish(this.announcement);
      this.announcement = undefined;
      tick();
    }, firstDelayMs);
    this.timer = setInterval(tick, CHECK_EVERY_MS);
  }

  /** Resolves once a background download and check (if any) has finished: for the tests. */
  async settled(): Promise<void> {
    await this.preparing;
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
        this.offer(this.available);
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

  /** The overlay's links: Update (the .dmg) and Restart now. True when the updater took it. */
  handleLink(url: string): boolean {
    if (url.endsWith(RESTART_HASH)) this.restartNow();
    else if (url.endsWith(INSTALL_HASH)) void this.install();
    else return false;
    return true;
  }

  /** The tray's Update item: Restart to update when one is ready, else the .dmg download. */
  installOrRestart(): void {
    if (this.ready) this.restartNow();
    else void this.install();
  }

  /** Restart now (the ready notice, tray, Dock menu): the helper swaps the app once it has quit. */
  restartNow(): void {
    if (!this.ready || this.helperStarted) return;
    if (this.startHelper(true)) this.opts.quit();
  }

  /** The app is quitting (will-quit): with Install updates automatically on, install what's ready. */
  quitting(): void {
    const autoInstall = this.opts.autoInstall?.() ?? false;
    if (shouldInstallOnQuit({ autoInstall, ready: Boolean(this.ready), helperStarted: this.helperStarted }))
      this.startHelper(false);
  }

  /** A newer version: download it in the background when this app can replace itself, else the .dmg. */
  private offer(update: AvailableUpdate): void {
    if (this.ready?.version === update.version) return this.publishReady(this.ready);
    if (this.preparing) return;
    this.preparing = (async () => {
      const blocker = await this.blocker(update);
      if (blocker) {
        this.log("info", `${update.version} will use the .dmg: ${blocker}`);
        return this.publishAvailable(update, update.manifestUrl ? blocker : undefined);
      }
      try {
        this.ready = await this.prepare(update);
        this.log("info", `${update.version} is downloaded and checked, ready to install`);
        this.publishReady(this.ready);
      } catch (err) {
        this.log("error", `Couldn't get ${update.version} ready: ${message(err)}`);
        this.publishAvailable(update, `the automatic update didn't work (${message(err)})`);
      }
    })().finally(() => {
      this.preparing = undefined;
      this.downloading = undefined;
      this.opts.onChange?.();
    });
  }

  private async blocker(update: AvailableUpdate): Promise<string | undefined> {
    if (!update.manifestUrl) return "this release has no automatic update";
    if (!this.opts.updatesDir) return "automatic updates aren't set up";
    if (update.version === this.failedVersion) return `installing ${update.version} didn't work last time`;
    return selfUpdateBlocker(this.opts.appPath, this.opts.access);
  }

  /** Downloads the zip into updates/<version>/, checks its sha256, unpacks and verifies the app. */
  private async prepare(update: AvailableUpdate): Promise<ReadyUpdate> {
    const res = await this.fetch(update.manifestUrl!, { headers: { "User-Agent": "JARVIS-Desk" } });
    if (!res.ok) throw new Error(`${MANIFEST_NAME} didn't download (HTTP ${res.status})`);
    const manifest: UpdateManifest = parseManifest(await res.json(), update.version);
    const dir = join(this.opts.updatesDir!, update.version);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const zip = join(dir, "update.zip");
    try {
      const sha256 = await this.download(manifest.url, zip, manifest.size, (f) => {
        this.downloading = f;
        this.opts.onChange?.();
      });
      if (sha256 !== manifest.sha256) throw new Error("the download's sha256 doesn't match latest-mac.json");
      const app = await unpackUpdate(zip, dir, update.version, this.opts.run ?? runTool);
      await rm(zip, { force: true });
      return { version: update.version, pageUrl: update.pageUrl, app };
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /** Writes the helper and pending.json, then starts the helper. Sync: it runs from will-quit too. */
  private startHelper(relaunch: boolean): boolean {
    const ready = this.ready!;
    const dir = this.opts.updatesDir!;
    try {
      const script = join(dir, "install.sh");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        script,
        helperScript({
          pid: this.opts.pid ?? process.pid,
          appPath: this.opts.appPath!,
          newApp: ready.app,
          previousApp: join(dir, "previous.app"),
          startedFile: join(dir, `started-${ready.version}`),
          logFile: this.opts.logFile?.() ?? join(dir, "install.log"),
          version: ready.version,
          relaunch,
        }),
        { mode: 0o755 },
      );
      const pending: PendingInstall = {
        version: ready.version,
        from: this.opts.currentVersion,
        pageUrl: ready.pageUrl,
      };
      writeFileSync(join(dir, "pending.json"), JSON.stringify(pending));
      (this.opts.spawnHelper ?? spawnDetached)(script);
      this.helperStarted = true;
      this.log("info", `Installing ${ready.version} once JARVIS quits${relaunch ? ", then reopening" : ""}`);
      return true;
    } catch (err) {
      this.log("error", `Couldn't start the update helper: ${message(err)}`);
      rmSync(join(dir, "pending.json"), { force: true });
      return false;
    }
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
      await mkdir(this.opts.downloadsDir, { recursive: true });
      await this.download(update.dmgUrl, part, update.bytes, (f) => this.progress(update, f));
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

  /**
   * Streams `url` into `dest`, reporting progress per whole percent; resolves with its sha256. Throws
   * on an HTTP error or a short download.
   */
  private async download(
    url: string,
    dest: string,
    bytes: number,
    onProgress: (fraction: number) => void,
  ): Promise<string> {
    const res = await this.fetch(url, { headers: { "User-Agent": "JARVIS-Desk" } });
    if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length")) || bytes;
    const hash = createHash("sha256");
    let done = 0;
    let lastPct = 0;
    const count = new Transform({
      transform: (chunk: Buffer, _enc, next) => {
        done += chunk.length;
        hash.update(chunk);
        const pct = total ? Math.floor((done / total) * 100) : 0;
        // A card per whole percent, not per chunk.
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(Math.min(1, done / total));
        }
        next(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      count,
      createWriteStream(dest),
    );
    if (total && done !== total) throw new Error(`The download stopped early (${done} of ${total} bytes)`);
    return hash.digest("hex");
  }

  private publishAvailable(update: AvailableUpdate, whyNotAutomatic?: string) {
    const why = whyNotAutomatic ? ` (It can't install itself: ${whyNotAutomatic}.)` : "";
    this.notice(
      "info",
      `JARVIS Desk ${update.version} is out`,
      `Update downloads it to Downloads and opens it; JARVIS then quits so you can drag the new JARVIS Desk onto the one in Applications (Replace).${why}`,
      [{ label: `Update to v${update.version}…`, url: `${update.pageUrl}${INSTALL_HASH}` }],
    );
  }

  private publishReady(ready: ReadyUpdate) {
    const onQuit = this.opts.autoInstall?.() ? " or it installs itself when you quit" : "";
    this.notice(
      "info",
      `JARVIS Desk ${ready.version} is ready`,
      `Restart now to update${onQuit}. JARVIS reopens on the new version in a few seconds.`,
      [{ label: "Restart now", url: `${ready.pageUrl}${RESTART_HASH}` }, { label: "Later" }],
    );
  }

  private log(level: "info" | "warn" | "error", text: string) {
    if (this.opts.log) this.opts.log(level, text);
    else if (level !== "info") console.warn("updater:", text);
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

  private notice(level: "info" | "warn", title: string, body: string, actions?: NoticeAction[]) {
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

/** The helper outlives the app: its own process group, no stdio tied to ours. */
function spawnDetached(script: string): void {
  spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
