// Automatic updates (JD-74) on CI's Mac: unpacks the .zip this job just built with the app's own code
// (ditto, Info.plist version, codesign), then runs the real update helper against a temp
// "Applications" folder holding a dummy old app: the swap, and both rollbacks. A fake `open` stands
// in for LaunchServices, so nothing launches, and the real /Applications is never touched.
// UPDATE_HELPER_SMOKE=1 runs the helper tests elsewhere (with a dummy new app).
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { helperScript, run, unpackUpdate } from "../../main/updateInstaller";

const mac = process.platform === "darwin";
const desk = fileURLToPath(new URL("../..", import.meta.url));
const exec = promisify(execFile);

let root: string;
test.beforeEach(async () => {
  test.skip(!mac && !process.env.UPDATE_HELPER_SMOKE, "The update helper runs on the macOS runner only");
  root = await mkdtemp(join(tmpdir(), "jarvis-update-"));
});
test.afterEach(async () => {
  await exec("chmod", ["-R", "u+w", root]).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

/** The zip `npm run dist:mac` made in this job, and the version it was built as. */
function builtZip() {
  const release = join(desk, "release");
  const zips = existsSync(release) ? readdirSync(release).filter((f) => f.endsWith(".zip")) : [];
  const version = (JSON.parse(readFileSync(join(desk, "package.json"), "utf8")) as { version: string })
    .version;
  return { zip: zips.length === 1 ? join(release, zips[0]!) : undefined, version };
}

/** A stand-in app: an Info.plist with its version, and a file saying which one it is. */
async function dummyApp(dir: string, which: string) {
  const app = join(dir, "JARVIS Desk.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${which}</string></dict></plist>`,
  );
  await writeFile(join(app, "which.txt"), which);
  return app;
}

/** The new app: the real one from this job's zip on the Mac, else a dummy. */
async function newApp(dir: string) {
  await mkdir(dir, { recursive: true });
  const { zip, version } = builtZip();
  if (mac && zip) return unpackUpdate(zip, dir, version);
  return dummyApp(dir, "new");
}

const which = (app: string) => {
  const marker = join(app, "which.txt");
  return existsSync(marker) ? readFileSync(marker, "utf8") : "new";
};

/** Writes the helper for a temp layout and runs it to the end, against a process that exits in 1 s. */
async function runHelper(opts: { startsOk: boolean; newApp?: string }) {
  const apps = join(root, "Applications");
  const updates = join(root, "updates");
  await mkdir(updates, { recursive: true });
  const appPath = await dummyApp(apps, "old");
  const fresh = opts.newApp ?? (await newApp(join(updates, "1.2.10")));
  const started = join(updates, "started-1.2.10");
  const opened = join(root, "opened.txt");
  const log = join(root, "desk.log");
  // The fake open: records what it opened; "starting" the new version creates the started file.
  const open = join(root, "open.sh");
  await writeFile(
    open,
    `#!/bin/sh\necho "$1" >> '${opened}'\n${opts.startsOk ? `grep -qs old "$1/which.txt" || touch '${started}'\n` : ""}`,
    { mode: 0o755 },
  );
  const script = join(updates, "install.sh");
  const running = spawn("sleep", ["1"]);
  await writeFile(
    script,
    helperScript({
      pid: running.pid!,
      appPath,
      newApp: fresh,
      previousApp: join(updates, "previous.app"),
      startedFile: started,
      logFile: log,
      version: "1.2.10",
      relaunch: true,
      startTimeoutS: 3,
      openCommand: open,
    }),
    { mode: 0o755 },
  );
  const status = await exec("/bin/sh", [script]).then(
    () => 0,
    (err: { code?: number }) => err.code ?? 1,
  );
  return {
    status,
    appPath,
    previous: join(updates, "previous.app"),
    opened: existsSync(opened) ? (await readFile(opened, "utf8")).trim().split("\n") : [],
    log: existsSync(log) ? await readFile(log, "utf8") : "",
  };
}

test("the zip built in this job unpacks into a signed app of this version", async () => {
  test.skip(!mac, "ditto and codesign are macOS tools");
  const { zip, version } = builtZip();
  expect(zip, "npm run dist:mac makes exactly one .zip").toBeDefined();
  const app = await unpackUpdate(zip!, join(root, "unpacked"), version);
  expect(app).toBe(join(root, "unpacked", "JARVIS Desk.app"));
  // The bundle's binary, its frameworks' symlinks and whisper-cli survive the round trip.
  expect(existsSync(join(app, "Contents", "MacOS", "JARVIS Desk"))).toBe(true);
  expect(existsSync(join(app, "Contents", "Resources", "whisper", "whisper-cli"))).toBe(true);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
});

test("the helper swaps in the new app, clears quarantine and relaunches it", async () => {
  const fresh = await newApp(join(root, "updates", "1.2.10"));
  if (mac) await run("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Test;", fresh]);
  const result = await runHelper({ startsOk: true, newApp: fresh });
  expect(result.status, result.log).toBe(0);
  expect(which(result.appPath)).toBe("new");
  expect(which(result.previous)).toBe("old");
  expect(result.opened).toEqual([result.appPath]);
  expect(result.log).toMatch(/INFO {2}\[updater\] Installed 1\.2\.10 at /);
  expect(result.log).toMatch(/INFO {2}\[updater\] 1\.2\.10 started/);
  if (mac) {
    await expect(run("/usr/bin/xattr", ["-p", "com.apple.quarantine", result.appPath])).rejects.toThrow();
    await run("/usr/bin/codesign", ["--verify", "--deep", result.appPath]);
  }
});

test("the helper puts the old app back when the new one doesn't start", async () => {
  const result = await runHelper({ startsOk: false });
  expect(result.status).toBe(1);
  expect(which(result.appPath)).toBe("old");
  expect(existsSync(result.previous)).toBe(false);
  // Opened the new version, then the old one again.
  expect(result.opened).toEqual([result.appPath, result.appPath]);
  expect(result.log).toMatch(/ERROR \[updater\] 1\.2\.10 didn't start in 3 s/);
  expect(result.log).toMatch(/WARN {2}\[updater\] Put the previous version back/);
});

test("the helper puts the old app back when the new one can't be moved in", async () => {
  test.skip(process.getuid?.() === 0, "root ignores the read-only folder this relies on");
  // The new app sits in a read-only folder, so moving it out fails after the old app moved aside.
  const locked = join(root, "updates", "locked");
  const fresh = await newApp(locked);
  await chmod(locked, 0o555);
  const result = await runHelper({ startsOk: true, newApp: fresh });
  expect(result.status).toBe(1);
  expect(which(result.appPath)).toBe("old");
  expect(result.opened).toEqual([result.appPath]);
  expect(result.log).toMatch(/ERROR \[updater\] Couldn't move the new app into /);
  expect(result.log).toMatch(/Put the previous version back/);
});
