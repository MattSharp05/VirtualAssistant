// JD-63: the real app path on CI's Mac. Every other smoke test runs on a scenario (the mock bridge), so
// the real preload bridge and a real server were never exercised and the orb went missing unnoticed.
// These launch WITHOUT a scenario, each in a fresh userData folder (JARVIS_DESK_TEST_USER_DATA, ignored
// when packaged): unpaired, and paired to a tiny fake Desk API started here (the device key comes from
// JARVIS_DESK_TEST_DEVICE_KEY, so the Keychain isn't needed). Both need the orb on screen and a desk.log
// with no renderer errors. Needs Electron's binary (macOS job only).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const KEY = "jd_smoke_0123456789abcdefghijklmnop";

/** /api/desk with just enough to pair: /me, the event stream, the mood, and empty lists for the rest. */
async function fakeDeskServer() {
  const streams: ServerResponse[] = [];
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/api\/desk/, "");
    paths.push(`${req.method} ${path}`);
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unknown device key" }));
    }
    if (path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": connected\n\n");
      streams.push(res);
      return;
    }
    const answers: Record<string, unknown> = {
      "/me": { id: "dev-smoke", name: "Smoke Mac" },
      "/mood": { mood: "green", reason: "all fine", dnd: { on: false } },
      "/usage": { available: false },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answers[path] ?? (req.method === "GET" ? [] : {})));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let id = 0;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paths,
    streams,
    /** Sends an event down every open stream, as the server's SSE hub does. */
    push: (event: unknown) => {
      for (const s of streams) s.write(`id: ${++id}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    close: () => {
      for (const s of streams) s.end();
      server.close();
    },
  };
}

async function launch(settings: Record<string, unknown>, deviceKey?: string) {
  const userData = mkdtempSync(join(tmpdir(), "jarvis-desk-smoke-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify(settings));
  const env: Record<string, string> = { JARVIS_DESK_TEST_USER_DATA: userData };
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "JARVIS_DESK_SCENARIO") env[k] = v;
  if (deviceKey) env.JARVIS_DESK_TEST_DEVICE_KEY = deviceKey;
  const app = await electron.launch({
    args: ["."],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env,
  });
  return { app, logFile: join(userData, "logs", "desk.log") };
}

/** The overlay's page (the first window may be Settings on an unpaired Mac). */
async function overlayPage(app: ElectronApplication): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => (found = app.windows().find((w) => w.url().includes("#/overlay"))), { timeout: 20_000 })
    .toBeTruthy();
  return found!;
}

/** Lines a renderer logged as errors (anything but main's own). */
const rendererErrors = (logFile: string) =>
  readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => / ERROR \[/.test(l) && !l.includes(" ERROR [main]"));

const skipOffMac = () =>
  test.skip(
    process.platform !== "darwin" && !process.env.ELECTRON_SMOKE,
    "Electron runs on the macOS runner only",
  );

// eslint-disable-next-line no-empty-pattern
test("real bridge, unpaired: the orb shows and Settings opens", async ({}) => {
  skipOffMac();
  test.setTimeout(60_000);
  const { app, logFile } = await launch({});
  try {
    const overlay = await overlayPage(app);
    await expect(overlay.locator("[data-orb-state]")).toBeVisible({ timeout: 20_000 });
    await expect(overlay.locator("[data-orb-state]")).toHaveAttribute("data-orb-state", "idle");
    // First launch: nothing to connect to yet, so Settings opens by itself.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.getTitle().startsWith("Settings") && w.isVisible()),
        ),
      )
      .toBe(true);
    await overlay.waitForTimeout(2_000);
    expect(readFileSync(logFile, "utf8")).toContain("JARVIS Desk");
    expect(rendererErrors(logFile)).toEqual([]);
  } finally {
    await app.close();
  }
});

// eslint-disable-next-line no-empty-pattern
test("real bridge, paired to a Desk API: the orb shows and follows the live stream", async ({}) => {
  skipOffMac();
  test.setTimeout(90_000);
  const server = await fakeDeskServer();
  const { app, logFile } = await launch({ serverUrl: server.url }, KEY);
  try {
    const overlay = await overlayPage(app);
    const orb = overlay.locator("[data-orb-state]");
    await expect(orb).toBeVisible({ timeout: 20_000 });
    // Connected: /me answered and the event stream is open.
    await expect.poll(() => server.streams.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(server.paths).toContain("GET /me");

    // Events from the server reach the overlay through the real bridge: orb state, a card, a notice.
    server.push({ type: "orb.state", state: "thinking" });
    await expect(orb).toHaveAttribute("data-orb-state", "thinking", { timeout: 10_000 });
    server.push({
      type: "card.show",
      card: {
        id: "smoke",
        createdAt: new Date().toISOString(),
        title: "Smoke card",
        body: "From the server",
        kind: "text",
      },
    });
    server.push({ type: "notice", at: new Date().toISOString(), level: "info", title: "Smoke notice" });
    await expect(overlay.getByRole("article", { name: "Smoke card" })).toBeVisible({ timeout: 10_000 });
    await expect(overlay.getByRole("article", { name: "Smoke notice" })).toBeVisible();
    // A malformed one is skipped, and the orb stays.
    server.push({ type: "card.show" });
    server.push({ type: "notice" });
    server.push({ type: "orb.state", state: "idle" });
    await expect(orb).toHaveAttribute("data-orb-state", "idle", { timeout: 10_000 });

    // The overlay is part of the screen, not a window: out of Mission Control, on top, on every Space.
    const flags = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("#/overlay"))!;
      return {
        hidden: w.isHiddenInMissionControl(),
        onTop: w.isAlwaysOnTop(),
        allSpaces: w.isVisibleOnAllWorkspaces(),
      };
    });
    expect(flags).toEqual({ hidden: true, onTop: true, allSpaces: true });
    // JD-62 on the real path: the tray is there, and so is the Dock icon.
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { __deskTray(): { exists: boolean } }).__deskTray().exists,
      ),
    ).toBe(true);
    expect(await app.evaluate(({ app }) => app.dock?.isVisible())).toBe(true);

    expect(rendererErrors(logFile)).toEqual([]);
  } finally {
    await app.close();
    server.close();
  }
});
