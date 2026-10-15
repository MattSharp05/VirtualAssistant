// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  UPDATE_CARD_ID,
  Updater,
  type GithubRelease,
} from "./updater";

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
