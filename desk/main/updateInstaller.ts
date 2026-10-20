// Automatic updates (JD-74, ADR 0010 addendum). The app is ad-hoc signed, so Squirrel can't update it;
// instead each release also carries a .zip of JARVIS Desk.app and latest-mac.json (version, zip URL,
// size, sha256). updater.ts downloads the zip into userData/updates/<version>/ and checks it; this file
// unpacks and verifies it (ditto, plutil, codesign), decides whether this copy of the app can replace
// itself, and writes the detached shell helper that swaps the app once it has quit, relaunches it and
// rolls back if anything goes wrong. No Electron in here: the tests use temp folders and fake commands.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MANIFEST_NAME = "latest-mac.json";
/** Only zips from this repo's desk releases are installed. */
export const DOWNLOAD_PREFIX = "https://github.com/MattSharp05/VirtualAssistant/releases/download/";
/** The helper restores the previous app when the new one hasn't said "started" in this long. */
export const START_TIMEOUT_S = 60;

/** latest-mac.json, written by release.yml (scripts/latest-mac.mjs). */
export interface UpdateManifest {
  version: string;
  /** The zip's download URL on this release. */
  url: string;
  size: number;
  sha256: string;
}

/** Reads latest-mac.json for the release tagged desk-v<version>; throws when anything doesn't add up. */
export function parseManifest(raw: unknown, version: string): UpdateManifest {
  const m = (raw ?? {}) as Partial<Record<keyof UpdateManifest, unknown>>;
  if (m.version !== version) throw new Error(`latest-mac.json is for ${String(m.version)}, not ${version}`);
  const prefix = `${DOWNLOAD_PREFIX}desk-v${version}/`;
  if (typeof m.url !== "string" || !m.url.startsWith(prefix) || !m.url.endsWith(".zip"))
    throw new Error(`latest-mac.json points somewhere else: ${String(m.url)}`);
  if (typeof m.size !== "number" || !(m.size > 0)) throw new Error("latest-mac.json has no size");
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256))
    throw new Error("latest-mac.json has no sha256");
  return { version, url: m.url, size: m.size, sha256: m.sha256 };
}

/** The .app bundle the running binary lives in (…/JARVIS Desk.app/Contents/MacOS/JARVIS Desk). */
export function appBundlePath(execPath: string): string | undefined {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m?.[1];
}

/**
 * Why this copy of the app can't replace itself (so the update falls back to the .dmg), or undefined
 * when it can: it must be a packaged .app in a folder JARVIS can write to, not on the disk image.
 */
export async function selfUpdateBlocker(
  appPath: string | undefined,
  access: (path: string, mode: number) => Promise<void> = fsAccess,
): Promise<string | undefined> {
  if (!appPath) return "this isn't an installed JARVIS Desk.app";
  if (appPath.startsWith("/Volumes/"))
    return "JARVIS Desk is running from the disk image. Drag it to Applications and open it from there";
  if (appPath.includes("/AppTranslocation/"))
    return "macOS is running a quarantined copy of JARVIS Desk. Move it to Applications and open it from there";
  for (const path of [dirname(appPath), appPath]) {
    try {
      await access(path, constants.W_OK);
    } catch {
      return `JARVIS can't write to ${path}`;
    }
  }
  return undefined;
}

/** On quit (⌘Q, Dock Quit, logout): install a downloaded update silently, when the setting's on. */
export function shouldInstallOnQuit(s: { autoInstall: boolean; ready: boolean; helperStarted: boolean }) {
  return s.autoInstall && s.ready && !s.helperStarted;
}

export type Run = (cmd: string, args: string[]) => Promise<string>;

/** Runs a macOS tool and resolves with its stdout; rejects with its stderr. */
export const run: Run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} failed: ${String(stderr).trim() || err.message}`)) : resolve(stdout),
    ),
  );

/**
 * Unpacks the zip into `dir` with ditto (keeps the signature, symlinks and permissions) and checks the
 * app inside: its Info.plist version must be `version` and its ad-hoc signature must verify.
 * Resolves with the unpacked app's path.
 */
export async function unpackUpdate(
  zip: string,
  dir: string,
  version: string,
  exec: Run = run,
): Promise<string> {
  await exec("/usr/bin/ditto", ["-x", "-k", zip, dir]);
  const apps = (await readdir(dir)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error(`The zip has ${apps.length} apps in it, not one`);
  const app = join(dir, apps[0]!);
  const found = (
    await exec("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      join(app, "Contents", "Info.plist"),
    ])
  ).trim();
  if (found !== version) throw new Error(`The unpacked app is version ${found}, not ${version}`);
  await exec("/usr/bin/codesign", ["--verify", "--deep", app]);
  return app;
}

/** 'it'\''s' quoting for /bin/sh: safe for any path. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface HelperOptions {
  /** The running app's process, which must exit before the swap. */
  pid: number;
  /** The installed app, normally /Applications/JARVIS Desk.app. */
  appPath: string;
  /** The verified new app in userData/updates/<version>/. */
  newApp: string;
  /** Where the old app goes: userData/updates/previous.app. */
  previousApp: string;
  /** The new version creates this when it has started (Updater.launched). */
  startedFile: string;
  /** desk.log (JD-63): every step goes there. */
  logFile: string;
  version: string;
  /** Restart now relaunches; an install on quit doesn't (and so has no start check). */
  relaunch: boolean;
  startTimeoutS?: number;
  /** /usr/bin/open; the macOS smoke test passes a fake to stand in for LaunchServices. */
  openCommand?: string;
}

/**
 * The detached helper (sh): waits for the app to quit, moves it to previous.app, moves the new app into
 * its place, clears quarantine and relaunches. If a move fails, or the relaunched app doesn't create
 * `startedFile` within the timeout, it puts the previous app back and opens that instead.
 */
export function helperScript(o: HelperOptions): string {
  const q = shellQuote;
  const timeout = o.startTimeoutS ?? START_TIMEOUT_S;
  return `#!/bin/sh
# JARVIS Desk update helper (JD-74), written by desk/main/updateInstaller.ts. Installs ${o.version}.
PID=${o.pid}
APP=${q(o.appPath)}
NEW=${q(o.newApp)}
PREV=${q(o.previousApp)}
STARTED=${q(o.startedFile)}
LOG=${q(o.logFile)}
OPEN=${q(o.openCommand ?? "/usr/bin/open")}
APP_PROCESS=${q(`^${regexEscape(o.appPath)}/Contents/MacOS/`)}
RELAUNCH=${o.relaunch ? 1 : 0}
TIMEOUT=${timeout}

log() { printf '%s %s [updater] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$LOG"; }
reopen() { [ "$RELAUNCH" = 1 ] && "$OPEN" "$APP"; }
restore() {
  rm -rf "$APP"
  if mv "$PREV" "$APP"; then log "WARN " "Put the previous version back"; else log "ERROR" "Couldn't put the previous version back: it's in $PREV"; fi
}

log "INFO " "Installing ${o.version}: waiting for JARVIS Desk (pid $PID) to quit"
waited=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 1
  waited=$((waited + 1))
  if [ "$waited" -ge 120 ]; then log "ERROR" "JARVIS Desk didn't quit in 120 s; update not installed"; exit 1; fi
done
if [ ! -d "$NEW" ]; then log "ERROR" "The new app isn't at $NEW; update not installed"; reopen; exit 1; fi
rm -rf "$PREV" "$STARTED"
if ! mv "$APP" "$PREV"; then log "ERROR" "Couldn't move the old app aside; update not installed"; reopen; exit 1; fi
log "INFO " "Moved the old app to $PREV"
if ! mv "$NEW" "$APP"; then log "ERROR" "Couldn't move the new app into $APP"; restore; reopen; exit 1; fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
log "INFO " "Installed ${o.version} at $APP"
[ "$RELAUNCH" = 1 ] || exit 0
if ! "$OPEN" "$APP"; then log "ERROR" "Couldn't open the new version"; restore; reopen; exit 1; fi
waited=0
while [ ! -e "$STARTED" ]; do
  sleep 1
  waited=$((waited + 1))
  if [ "$waited" -ge "$TIMEOUT" ]; then
    log "ERROR" "${o.version} didn't start in $TIMEOUT s; going back to the previous version"
    pkill -f "$APP_PROCESS" 2>/dev/null
    sleep 2
    restore
    reopen
    exit 1
  fi
done
log "INFO " "${o.version} started"
`;
}
