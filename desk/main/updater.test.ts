// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskEvent } from "@jarvis/shared";
import {
  CHECK_EVERY_MS,
  compareVersions,
  deskTagVersion,
  INSTALL_HASH,
  newerRelease,
  RELEASES_URL,
  RESTART_HASH,
  UPDATE_CARD_ID,
  Updater,
  type GithubRelease,
} from "./updater";
import {
  appBundlePath,
  helperScript,
  parseManifest,
  selfUpdateBlocker,
  shellQuote,
  shouldInstallOnQuit,
  START_TIMEOUT_S,
} from "./updateInstaller";

const release = (tag: string, over: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/MattSharp05/VirtualAssistant/releases/tag/${tag}`,
  assets: [
    {
      name: `JARVIS Desk-${tag.replace("desk-v", "")}-arm64.dmg`,
      size: 2_000_000,
      browser_download_url: `https://github.com/MattSharp05/VirtualAssistant/releases/download/${tag}/desk.dmg`,
    },
  ],
  ...over,
});

describe("version comparison", () => {
  it("compares numerically, not as text: desk-v1.2.10 > desk-v1.2.9", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.9", "1.2.10")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    // A CI build (0.0.0-ci.N) ranks below its X.Y.Z, so any release is newer.
    expect(compareVersions("0.0.0-ci.42", "0.0.0")).toBeLessThan(0);
    expect(newerRelease([release("desk-v1.2.10"), release("desk-v1.2.9")], "1.2.9")?.version).toBe("1.2.10");
    expect(newerRelease([release("desk-v1.2.9"), release("desk-v1.2.10")], "1.2.9")?.version).toBe("1.2.10");
  });

  it("ignores non-desk tags, prereleases, drafts and releases without a .dmg", () => {
    expect(deskTagVersion("desk-v1.2.10")).toEqual([1, 2, 10]);
    expect(deskTagVersion("v9.0.0")).toBeUndefined();
    expect(deskTagVersion("server-v9.0.0")).toBeUndefined();
    expect(deskTagVersion("desk-v1.3.0-rc.1")).toBeUndefined();
    const releases = [
      release("v9.0.0"),
      release("desk-v1.4.0", { prerelease: true }),
      release("desk-v1.3.0-beta.2"),
      release("desk-v1.3.5", { draft: true }),
      release("desk-v1.3.1", { assets: [] }),
      release("desk-v1.2.10"),
    ];
    const update = newerRelease(releases, "1.2.9");
    expect(update).toMatchObject({
      version: "1.2.10",
      dmgName: "JARVIS Desk-1.2.10-arm64.dmg",
      bytes: 2_000_000,
      pageUrl: "https://github.com/MattSharp05/VirtualAssistant/releases/tag/desk-v1.2.10",
    });
    expect(newerRelease(releases, "1.2.10")).toBeUndefined();
    expect(newerRelease(releases, "1.3.0")).toBeUndefined();
    expect(newerRelease([], "1.0.0")).toBeUndefined();
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(over: { fetch?: typeof fetch; enabled?: boolean; current?: string; dir?: string } = {}) {
  const events: DeskEvent[] = [];
  const opened: string[] = [];
  const opts = {
    currentVersion: over.current ?? "1.2.9",
    enabled: () => over.enabled ?? true,
    downloadsDir: over.dir ?? "/nowhere",
    publish: (e: DeskEvent) => void events.push(e),
    openPath: async (p: string) => {
      opened.push(p);
      return "";
    },
    quit: vi.fn(),
    onChange: vi.fn(),
    fetch: over.fetch ?? (vi.fn(async () => json([release("desk-v1.2.10")])) as unknown as typeof fetch),
    now: () => new Date("2026-10-15T09:00:00Z"),
  };
  return { updater: new Updater(opts), events, opened, opts };
}

const notices = (events: DeskEvent[]) =>
  events.filter((e): e is Extract<DeskEvent, { type: "notice" }> => e.type === "notice");

describe("checking for updates", () => {
  it("asks GitHub's release list and offers a newer version once, with an Update button", async () => {
    const { updater, events, opts } = setup();
    const found = await updater.check();
    expect(found?.version).toBe("1.2.10");
    expect(vi.mocked(opts.fetch).mock.calls[0]![0]).toBe(RELEASES_URL);
    const [notice] = notices(events);
    expect(notice).toMatchObject({ level: "info", title: "JARVIS Desk 1.2.10 is out" });
    expect(notice!.body).toMatch(/drag the new JARVIS Desk onto the one in Applications/);
    expect(notice!.actions![0]!.label).toBe("Update to v1.2.10…");
    expect(updater.isInstallLink(notice!.actions![0]!.url!)).toBe(true);
    expect(updater.isInstallLink("https://github.com/x/releases")).toBe(false);
    expect(updater.state.available?.version).toBe("1.2.10");
    // The daily check doesn't repeat the same news; a forced check does.
    await updater.check();
    expect(notices(events)).toHaveLength(1);
    await updater.check({ forced: true });
    expect(notices(events)).toHaveLength(2);
  });

  it("a background check is silent on errors and when up to date", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const offline = setup({ fetch: vi.fn(async () => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) });
    expect(await offline.updater.check()).toBeUndefined();
    const limited = setup({ fetch: vi.fn(async () => json({ message: "rate limited" }, 403)) });
    await limited.updater.check();
    const current = setup({ current: "1.2.10" });
    await current.updater.check();
    expect([...offline.events, ...limited.events, ...current.events]).toEqual([]);
    expect(offline.updater.state.checking).toBe(false);
    warn.mockRestore();
  });

  it("a forced check (tray) surfaces errors and says when it's up to date", async () => {
    const offline = setup({ fetch: vi.fn(async () => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) });
    await offline.updater.check({ forced: true });
    expect(notices(offline.events)[0]).toMatchObject({
      level: "warn",
      title: "Couldn't check for updates",
      body: "getaddrinfo ENOTFOUND",
    });
    const limited = setup({ fetch: vi.fn(async () => json({ message: "rate limited" }, 403)) });
    await limited.updater.check({ forced: true });
    expect(notices(limited.events)[0]).toMatchObject({ level: "warn", body: "GitHub answered 403" });
    const current = setup({ current: "1.2.10" });
    await current.updater.check({ forced: true });
    expect(notices(current.events)[0]).toMatchObject({
      level: "info",
      title: "JARVIS Desk is up to date",
      body: "You have the latest version, 1.2.10.",
    });
  });

  it("checks after launch and every 24 h, only while Check for updates is on", async () => {
    vi.useFakeTimers();
    try {
      const on = setup();
      on.updater.start(1000);
      expect(on.opts.fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(on.opts.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
      expect(on.opts.fetch).toHaveBeenCalledTimes(2);
      on.updater.stop();
      const off = setup({ enabled: false });
      off.updater.start(1000);
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS + 1000);
      expect(off.opts.fetch).not.toHaveBeenCalled();
      off.updater.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installing an update", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-updater-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const dmg = Buffer.alloc(2_000_000, "JARVIS");

  it("downloads the .dmg into Downloads with a progress card, opens it and quits", async () => {
    const fetch = vi.fn(async (url: string) =>
      url === RELEASES_URL
        ? json([release("desk-v1.2.10")])
        : new Response(dmg, { headers: { "content-length": String(dmg.length) } }),
    ) as unknown as typeof globalThis.fetch;
    const { updater, events, opened, opts } = setup({ fetch, dir });
    await updater.check();
    await updater.install();
    const path = join(dir, "JARVIS Desk-1.2.10-arm64.dmg");
    expect(opened).toEqual([path]);
    // Buffer.equals, not toEqual: a deep compare of 2 MB takes seconds.
    expect((await readFile(path)).equals(dmg)).toBe(true);
    expect(await readdir(dir)).toEqual(["JARVIS Desk-1.2.10-arm64.dmg"]); // no .part left
    expect(opts.quit).toHaveBeenCalled();
    const cards = events.flatMap((e) => (e.type === "card.show" ? [e.card] : []));
    expect(cards.every((c) => c.id === UPDATE_CARD_ID)).toBe(true);
    expect(cards[0]!.body).toMatch(/^\*\*0%\*\* of 2 MB/);
    expect(cards.some((c) => c.body.startsWith("**100%**"))).toBe(true);
    // Not a card per chunk: at most one per whole percent.
    expect(cards.length).toBeLessThanOrEqual(102);
    expect(cards.at(-1)!.body).toMatch(/drag \*\*JARVIS Desk\*\* onto \*\*Applications\*\*/);
  });

  it("a failed download says so on the card, cleans up and doesn't quit", async () => {
    const fetch = vi.fn(async (url: string) =>
      url === RELEASES_URL ? json([release("desk-v1.2.10")]) : new Response("nope", { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const { updater, events, opts } = setup({ fetch, dir });
    await updater.check();
    await updater.install();
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "card.show", card: { title: "Update didn't download" } });
    expect(opts.quit).not.toHaveBeenCalled();
    expect(updater.state.downloading).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("does nothing without a newer version", async () => {
    const { updater, events } = setup({ current: "1.2.10", dir });
    await updater.check();
    await updater.install();
    expect(events).toEqual([]);
  });

  it("the notice's Update link is the release page plus the install marker", async () => {
    const { updater, events } = setup();
    await updater.check();
    expect(notices(events)[0]!.actions![0]!.url).toBe(
      `https://github.com/MattSharp05/VirtualAssistant/releases/tag/desk-v1.2.10${INSTALL_HASH}`,
    );
  });
});

describe("automatic updates (JD-74)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-autoupdate-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const zip = Buffer.alloc(300_000, "ZIP");
  const sha = createHash("sha256").update(zip).digest("hex");
  const tag = "desk-v1.2.10";
  const base = `https://github.com/MattSharp05/VirtualAssistant/releases/download/${tag}`;
  const zipUrl = `${base}/JARVIS-Desk-1.2.10-arm64-mac.zip`;
  const manifestUrl = `${base}/latest-mac.json`;
  const withZip = (over: Partial<GithubRelease> = {}) => {
    const r = release(tag, over);
    return {
      ...r,
      assets: [
        ...r.assets,
        { name: "JARVIS-Desk-1.2.10-arm64-mac.zip", size: zip.length, browser_download_url: zipUrl },
        { name: "latest-mac.json", size: 200, browser_download_url: manifestUrl },
      ],
    };
  };

  function auto(
    over: {
      manifest?: unknown;
      body?: Buffer<ArrayBuffer>;
      autoInstall?: boolean;
      appPath?: string;
      unpackedVersion?: string;
      access?: (p: string) => Promise<void>;
      releases?: GithubRelease[];
    } = {},
  ) {
    const fetch = vi.fn(async (url: string) => {
      if (url === RELEASES_URL) return json(over.releases ?? [withZip()]);
      if (url === manifestUrl)
        return json(over.manifest ?? { version: "1.2.10", url: zipUrl, size: zip.length, sha256: sha });
      if (url === zipUrl) return new Response(over.body ?? zip);
      return new Response("dmg");
    }) as unknown as typeof globalThis.fetch;
    // ditto unpacks a stand-in app; plutil reads its version; codesign passes.
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd.endsWith("ditto")) {
        await mkdir(join(args.at(-1)!, "JARVIS Desk.app", "Contents"), { recursive: true });
        return "";
      }
      if (cmd.endsWith("plutil")) return `${over.unpackedVersion ?? "1.2.10"}\n`;
      return "";
    });
    const spawned: string[] = [];
    const logs: string[] = [];
    const s = setup({ fetch, dir: join(dir, "Downloads") });
    const updater = new Updater({
      ...s.opts,
      updatesDir: join(dir, "updates"),
      appPath: over.appPath ?? "/Applications/JARVIS Desk.app",
      autoInstall: () => over.autoInstall ?? true,
      logFile: () => join(dir, "desk.log"),
      log: (level, m) => void logs.push(`${level}: ${m}`),
      pid: 4242,
      spawnHelper: (script) => void spawned.push(script),
      run,
      access: over.access ?? (async () => {}),
    });
    return { updater, events: s.events, quit: s.opts.quit, fetch, run, spawned, logs };
  }

  it("picks the release's latest-mac.json, and only when it has one", () => {
    expect(newerRelease([withZip()], "1.2.9")?.manifestUrl).toBe(manifestUrl);
    expect(newerRelease([release(tag)], "1.2.9")?.manifestUrl).toBeUndefined();
  });

  it("downloads the zip in the background, checks it, and offers Restart now / Later", async () => {
    const { updater, events, run, logs } = auto();
    await updater.check();
    await updater.settled();
    expect(run.mock.calls.map(([cmd]) => cmd)).toEqual([
      "/usr/bin/ditto",
      "/usr/bin/plutil",
      "/usr/bin/codesign",
    ]);
    expect(run.mock.calls[0]![1]).toEqual([
      "-x",
      "-k",
      join(dir, "updates/1.2.10/update.zip"),
      join(dir, "updates/1.2.10"),
    ]);
    expect(updater.state.ready).toBe("1.2.10");
    expect(updater.state.downloading).toBeUndefined();
    // No .dmg notice, no progress cards: just the ready notice.
    expect(events).toHaveLength(1);
    const [ready] = notices(events);
    expect(ready).toMatchObject({ title: "JARVIS Desk 1.2.10 is ready" });
    expect(ready!.body).toMatch(/installs itself when you quit/);
    expect(ready!.actions!.map((a) => a.label)).toEqual(["Restart now", "Later"]);
    expect(ready!.actions![0]!.url!.endsWith(RESTART_HASH)).toBe(true);
    // The zip is gone once unpacked; the app waits in updates/1.2.10.
    expect(await readdir(join(dir, "updates/1.2.10"))).toEqual(["JARVIS Desk.app"]);
    expect(logs).toContain("info: 1.2.10 is downloaded and checked, ready to install");
  });

  it("refuses a zip whose sha256 doesn't match, and falls back to the .dmg with the reason", async () => {
    const { updater, events, run, logs } = auto({ body: Buffer.alloc(zip.length, "BAD") });
    await updater.check();
    await updater.settled();
    expect(updater.state.ready).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    const [notice] = notices(events);
    expect(notice!.title).toBe("JARVIS Desk 1.2.10 is out");
    expect(notice!.body).toMatch(/sha256 doesn't match/);
    expect(notice!.actions![0]!.url!.endsWith(INSTALL_HASH)).toBe(true);
    expect(logs.some((l) => l.startsWith("error: Couldn't get 1.2.10 ready"))).toBe(true);
    // Nothing left behind.
    expect(await readdir(join(dir, "updates"))).toEqual([]);
  });

  it("refuses a manifest for another version or host, and an unpacked app of another version", async () => {
    for (const manifest of [
      { version: "1.2.11", url: zipUrl, size: zip.length, sha256: sha },
      { version: "1.2.10", url: "https://evil.example/JARVIS.zip", size: zip.length, sha256: sha },
      { version: "1.2.10", url: zipUrl.replace("https", "http"), size: zip.length, sha256: sha },
    ]) {
      const { updater, events } = auto({ manifest });
      await updater.check();
      await updater.settled();
      expect(updater.state.ready).toBeUndefined();
      expect(notices(events)[0]!.title).toBe("JARVIS Desk 1.2.10 is out");
    }
    const { updater, events } = auto({ unpackedVersion: "1.2.9" });
    await updater.check();
    await updater.settled();
    expect(updater.state.ready).toBeUndefined();
    expect(notices(events)[0]!.body).toMatch(/version 1.2.9, not 1.2.10/);
  });

  it("falls back to the .dmg, saying why, when the app can't replace itself", async () => {
    const dmgOnly = auto({ appPath: "/Volumes/JARVIS Desk/JARVIS Desk.app" });
    await dmgOnly.updater.check();
    await dmgOnly.updater.settled();
    expect(dmgOnly.fetch).toHaveBeenCalledTimes(1); // no zip download
    expect(notices(dmgOnly.events)[0]!.body).toMatch(/running from the disk image/);
    const readOnly = auto({
      access: async (p) => {
        if (p === "/Applications") throw new Error("EACCES");
      },
    });
    await readOnly.updater.check();
    await readOnly.updater.settled();
    expect(notices(readOnly.events)[0]!.body).toMatch(/can't write to \/Applications/);
    // A release from before JD-74 just gets the .dmg notice, as before.
    const old = auto({ releases: [release(tag)] });
    await old.updater.check();
    await old.updater.settled();
    expect(notices(old.events)[0]!.body).not.toMatch(/can't install itself/);
  });

  it("Restart now writes the helper and pending.json, starts the helper and quits", async () => {
    const { updater, spawned, quit } = auto();
    await updater.check();
    await updater.settled();
    expect(updater.handleLink(`https://x/releases/tag/${tag}${RESTART_HASH}`)).toBe(true);
    const script = join(dir, "updates/install.sh");
    expect(spawned).toEqual([script]);
    expect(quit).toHaveBeenCalledOnce();
    const text = await readFile(script, "utf8");
    expect(text).toContain("PID=4242");
    expect(text).toContain("APP='/Applications/JARVIS Desk.app'");
    expect(text).toContain(`NEW='${join(dir, "updates/1.2.10/JARVIS Desk.app")}'`);
    expect(text).toContain("RELAUNCH=1");
    expect(JSON.parse(await readFile(join(dir, "updates/pending.json"), "utf8"))).toEqual({
      version: "1.2.10",
      from: "1.2.9",
      pageUrl: `https://github.com/MattSharp05/VirtualAssistant/releases/tag/${tag}`,
    });
    // The quit that follows doesn't start a second helper.
    updater.quitting();
    expect(spawned).toHaveLength(1);
  });

  it("installs on quit (no relaunch) only with Install updates automatically on", async () => {
    const on = auto();
    on.updater.quitting(); // nothing downloaded yet
    expect(on.spawned).toEqual([]);
    await on.updater.check();
    await on.updater.settled();
    on.updater.quitting();
    expect(on.spawned).toHaveLength(1);
    expect(await readFile(on.spawned[0]!, "utf8")).toContain("RELAUNCH=0");
    const off = auto({ autoInstall: false });
    await off.updater.check();
    await off.updater.settled();
    expect(notices(off.events)[0]!.body).not.toMatch(/when you quit/);
    off.updater.quitting();
    expect(off.spawned).toEqual([]);
  });

  it("after the helper: tells it the new version started and shows Updated to <v>", async () => {
    const updates = join(dir, "updates");
    await mkdir(join(updates, "1.2.10"), { recursive: true });
    await writeFile(
      join(updates, "pending.json"),
      JSON.stringify({ version: "1.2.10", from: "1.2.9", pageUrl: "https://notes" }),
    );
    vi.useFakeTimers();
    try {
      const events: DeskEvent[] = [];
      const updater = new Updater({
        ...setup().opts,
        currentVersion: "1.2.10",
        enabled: () => false,
        publish: (e) => void events.push(e),
        updatesDir: updates,
      });
      updater.launched();
      expect((await readdir(updates)).sort()).toEqual(["started-1.2.10"]);
      updater.start(1000);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(events[0]).toMatchObject({
        type: "card.show",
        card: { title: "Updated to 1.2.10", link: { label: "Release notes", url: "https://notes" } },
      });
      updater.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("after a rollback: says so, and that version uses the .dmg from then on", async () => {
    const updates = join(dir, "updates");
    await mkdir(updates, { recursive: true });
    await writeFile(
      join(updates, "pending.json"),
      JSON.stringify({ version: "1.2.10", from: "1.2.9", pageUrl: "x" }),
    );
    const { updater, events, fetch } = auto();
    updater.launched();
    expect(JSON.parse(await readFile(join(updates, "failed.json"), "utf8"))).toEqual({ version: "1.2.10" });
    await updater.check();
    await updater.settled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(notices(events)[0]!.body).toMatch(/didn't work last time/);
  });
});

describe("the update installer", () => {
  it("finds the .app bundle the app runs from", () => {
    expect(appBundlePath("/Applications/JARVIS Desk.app/Contents/MacOS/JARVIS Desk")).toBe(
      "/Applications/JARVIS Desk.app",
    );
    expect(appBundlePath("/usr/local/bin/electron")).toBeUndefined();
  });

  it("only replaces itself from a writable folder, not the disk image or a quarantined copy", async () => {
    const ok = async () => {};
    expect(await selfUpdateBlocker("/Applications/JARVIS Desk.app", ok)).toBeUndefined();
    expect(await selfUpdateBlocker(undefined, ok)).toMatch(/isn't an installed/);
    expect(await selfUpdateBlocker("/Volumes/JARVIS Desk 1.2.9/JARVIS Desk.app", ok)).toMatch(/disk image/);
    expect(
      await selfUpdateBlocker("/private/var/folders/x/AppTranslocation/ABC/d/JARVIS Desk.app", ok),
    ).toMatch(/quarantined copy/);
    const denied = async (p: string) => {
      if (p.endsWith(".app")) throw new Error("EACCES");
    };
    expect(await selfUpdateBlocker("/Applications/JARVIS Desk.app", denied)).toMatch(
      "JARVIS can't write to /Applications/JARVIS Desk.app",
    );
  });

  it("decides to install on quit only with the setting on, an update ready and no helper yet", () => {
    expect(shouldInstallOnQuit({ autoInstall: true, ready: true, helperStarted: false })).toBe(true);
    expect(shouldInstallOnQuit({ autoInstall: false, ready: true, helperStarted: false })).toBe(false);
    expect(shouldInstallOnQuit({ autoInstall: true, ready: false, helperStarted: false })).toBe(false);
    expect(shouldInstallOnQuit({ autoInstall: true, ready: true, helperStarted: true })).toBe(false);
  });

  it("writes a helper with every path quoted for the shell", () => {
    const script = helperScript({
      pid: 77,
      appPath: "/Users/matt/My Apps/JARVIS Desk.app",
      newApp: "/Users/matt/Library/Application Support/@jarvis/desk/updates/1.2.10/JARVIS Desk.app",
      previousApp: "/Users/matt/it's here/previous.app",
      startedFile: "/tmp/started $(rm -rf ~)",
      logFile: "/Users/matt/Library/Logs/JARVIS Desk/desk.log",
      version: "1.2.10",
      relaunch: true,
    });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("APP='/Users/matt/My Apps/JARVIS Desk.app'");
    expect(script).toContain(
      "NEW='/Users/matt/Library/Application Support/@jarvis/desk/updates/1.2.10/JARVIS Desk.app'",
    );
    expect(script).toContain(`PREV='/Users/matt/it'\\''s here/previous.app'`);
    expect(script).toContain("STARTED='/tmp/started $(rm -rf ~)'");
    expect(script).toContain("LOG='/Users/matt/Library/Logs/JARVIS Desk/desk.log'");
    expect(script).toContain("OPEN='/usr/bin/open'");
    expect(script).toContain("APP_PROCESS='^/Users/matt/My Apps/JARVIS Desk\\.app/Contents/MacOS/'");
    expect(script).toContain(`TIMEOUT=${START_TIMEOUT_S}`);
    // Every use of a path goes through its quoted variable.
    expect(script).toMatch(/mv "\$APP" "\$PREV"/);
    expect(script).toMatch(/mv "\$NEW" "\$APP"/);
    expect(script).toMatch(/xattr -dr com\.apple\.quarantine "\$APP"/);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("reads latest-mac.json only for this release's zip on GitHub over https", () => {
    const url = "https://github.com/MattSharp05/VirtualAssistant/releases/download/desk-v1.2.10/JARVIS.zip";
    const m = { version: "1.2.10", url, size: 10, sha256: "a".repeat(64) };
    expect(parseManifest(m, "1.2.10")).toEqual(m);
    expect(() => parseManifest(m, "1.2.11")).toThrow(/not 1.2.11/);
    expect(() =>
      parseManifest({ ...m, url: url.replace("desk-v1.2.10", "desk-v1.2.9") }, "1.2.10"),
    ).toThrow();
    expect(() => parseManifest({ ...m, sha256: "nope" }, "1.2.10")).toThrow(/sha256/);
    expect(() => parseManifest(null, "1.2.10")).toThrow();
  });
});
