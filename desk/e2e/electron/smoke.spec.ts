// The real app on CI's Mac: launches on the demo-day scenario, checks the overlay window (transparent,
// always on top, on every Space) and the orb, saves a screenshot and writes idle memory/CPU to the job
// summary. Needs Electron's binary (macOS job only).
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

// Playwright needs the fixtures argument destructured, even when empty.
// eslint-disable-next-line no-empty-pattern
test("JARVIS Desk launches its overlay with the orb", async ({}, testInfo) => {
  test.skip(
    process.platform !== "darwin" && !process.env.ELECTRON_SMOKE,
    "Electron runs on the macOS runner only",
  );
  const app = await electron.launch({
    args: ["."],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, JARVIS_DESK_SCENARIO: "orb-thinking" },
  });
  try {
    const window = await app.firstWindow();
    await expect(window.locator("[data-orb-state]")).toHaveAttribute("data-orb-state", "thinking", {
      timeout: 20_000,
    });
    const overlay = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        onTop: w.isAlwaysOnTop(),
        allSpaces: w.isVisibleOnAllWorkspaces(),
      })),
    );
    expect(overlay).toEqual([{ onTop: true, allSpaces: true }]);
    // See-through: the page paints nothing but the orb. (The window is created with transparent: true;
    // macOS capturePage() composites onto black, so the pixels can't prove it from in here: manual QA.)
    expect(await window.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );
    // JD-20: the ring's buttons open framed windows, and a window reopens where it was left.
    const openHello = () => app.evaluate(({ ipcMain }) => void ipcMain.emit("desk:open-window", {}, "hello"));
    const helloWindow = () =>
      app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith("Hello"));
        return w ? { bounds: w.getBounds(), visible: w.isVisible() } : undefined;
      });
    await openHello();
    await expect.poll(async () => (await helloWindow())?.visible, { timeout: 10_000 }).toBe(true);
    const moved = { x: 140, y: 160, width: 520, height: 360 };
    await app.evaluate(({ BrowserWindow }, b) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith("Hello"))!;
      w.setBounds(b);
      w.emit("moved");
      w.close();
    }, moved);
    await expect.poll(helloWindow).toBeUndefined();
    await openHello();
    await expect.poll(async () => (await helloWindow())?.bounds, { timeout: 10_000 }).toEqual(moved);
    // JD-47: camera hands find a window by its title bar (in the overlay's coordinates) and move it.
    type Hands = {
      windowAt(p: { x: number; y: number }, part: string): Promise<{ id: string; bounds: typeof moved }>;
      setBounds(id: string, b: typeof moved, done: boolean): void;
    };
    // The point is in the overlay's own coordinates, so offset it by where the overlay sits on screen.
    // The reopened window has its bounds before it shows, so wait until it can be grabbed.
    const grab = () =>
      window.evaluate(
        (p) =>
          (window as unknown as { desk: { hands: Hands } }).desk.hands.windowAt(
            { x: p.x - globalThis.screenX, y: p.y - globalThis.screenY },
            "titlebar",
          ),
        { x: moved.x + 60, y: moved.y + 20 },
      );
    await expect.poll(async () => (await grab())?.id, { timeout: 10_000 }).toBe("hello");
    const grabbed = await grab();
    await window.evaluate(
      (b) => (window as unknown as { desk: { hands: Hands } }).desk.hands.setBounds("hello", b, true),
      { ...grabbed.bounds, x: grabbed.bounds.x + 40 },
    );
    await expect
      .poll(async () => (await helloWindow())?.bounds, { timeout: 5_000 })
      .toEqual({ ...moved, x: moved.x + 40 });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle().startsWith("Hello"))
        ?.close(),
    );

    // JD-26: the Settings window opens from the tray's "Settings…" (same IPC path as the launcher).
    await app.evaluate(({ ipcMain }) => void ipcMain.emit("desk:open-window", {}, "settings"));
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some((w) => w.getTitle().startsWith("Settings") && w.isVisible()),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // JD-28: ⌘⇧Space toggles the command bar from any app.
    expect(
      await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("CommandOrControl+Shift+Space")),
    ).toBe(true);
    // JD-24: the debug listen shortcut (⌘⌥L) is registered.
    expect(
      await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("CommandOrControl+Alt+L")),
    ).toBe(true);

    // JD-37: Work mode opens the four windows (closing Settings); Focus closes them all.
    const titles = () =>
      app.evaluate(({ BrowserWindow }) =>
        ["Sessions", "Today", "Chat", "To-do", "Settings"].filter((t) =>
          BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.getTitle().startsWith(t)),
        ),
      );
    const applyLayout = (name: string) =>
      window.evaluate(
        (n) =>
          (
            window as unknown as { desk: { layouts: { apply(n: string): Promise<void> } } }
          ).desk.layouts.apply(n),
        name,
      );
    await applyLayout("Work mode");
    await expect.poll(titles, { timeout: 15_000 }).toEqual(["Sessions", "Today", "Chat", "To-do"]);
    await applyLayout("Focus");
    await expect.poll(titles, { timeout: 10_000 }).toEqual([]);

    // JD-40: the bridge uploads files dropped on the orb or a window.
    expect(
      await window.evaluate(
        () => typeof (globalThis as unknown as { desk: { files?: { upload?: unknown } } }).desk.files?.upload,
      ),
    ).toBe("function");

    const shot = testInfo.outputPath("electron-smoke.png");
    await window.screenshot({ path: shot });
    await testInfo.attach("app", { path: shot, contentType: "image/png" });

    await window.waitForTimeout(10_000);
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
    const rssMb = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024;
    const cpu = metrics.reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0);
    const line = `Idle after 10 s: ${rssMb.toFixed(0)} MB RSS across ${metrics.length} processes, ${cpu.toFixed(1)}% CPU`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Electron smoke\n${line}\n`);
  } finally {
    await app.close();
  }
});

// JD-59: the browser actions JARVIS calls over rpc, on a local test page in the real Browser window:
// open, snapshot, type in a field, click a button and read the result back.
// eslint-disable-next-line no-empty-pattern
test("Browser: open, snapshot, type, click and read back", async ({}) => {
  test.skip(
    process.platform !== "darwin" && !process.env.ELECTRON_SMOKE,
    "Electron runs on the macOS runner only",
  );
  test.setTimeout(90_000);
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Greeter</title>
      <label>Name <input id="name"></label>
      <button onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value">Greet</button>
      <p id="out">Nobody greeted yet</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const app = await electron.launch({
    args: ["."],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, JARVIS_DESK_SCENARIO: "empty" },
  });
  try {
    await app.firstWindow();
    type Snapshot = { text: string; url: string; title: string; change: string };
    const rpc = <T>(kind: string, payload: unknown) =>
      app.evaluate(
        (_electron, a) =>
          (
            globalThis as unknown as { __deskRpc(kind: string, payload: unknown): Promise<unknown> }
          ).__deskRpc(a.kind, a.payload),
        { kind, payload },
      ) as Promise<T>;
    const opened = await rpc<{ url: string; title: string }>("browser.open", { url });
    expect(opened).toMatchObject({ url, title: "Greeter" });
    // The Browser window opened for it.
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.getTitle().startsWith("Browser") && w.isVisible()),
      ),
    ).toBe(true);

    const first = await rpc<Snapshot>("browser.snapshot", {});
    const field = first.text.match(/\[(\d+)\] textbox “Name”/)?.[1];
    const button = first.text.match(/\[(\d+)\] button “Greet”/)?.[1];
    expect(first.text).toContain("Nobody greeted yet");
    expect(field && button).toBeTruthy();
    // Refs stay put on an unchanged page.
    expect((await rpc<Snapshot>("browser.snapshot", {})).text).toBe(first.text);

    await rpc("browser.type", { ref: Number(field), text: "Matthew" });
    const clicked = await rpc<Snapshot>("browser.click", { ref: Number(button) });
    expect(clicked.change).toBe("page changed");
    const after = await rpc<Snapshot>("browser.snapshot", {});
    expect(after.text).toContain("Hello, Matthew");
    expect(after.text).toContain(`[${field}] textbox “Name” value=“Matthew”`);
  } finally {
    await app.close();
    server.close();
  }
});

// JD-42: Camera hands' CPU while tracking (budget ≤ 15% on Apple Silicon), with Chromium's fake
// camera (no hands in it, so the palm detector runs every frame, the costlier path). Recorded in the
// job summary (or why it couldn't track); a CI VM's numbers are a guide, Matthew's Mac is the real measurement (manual QA).
// eslint-disable-next-line no-empty-pattern
test("Camera hands: CPU while tracking", async ({}) => {
  test.skip(
    process.platform !== "darwin" && !process.env.ELECTRON_SMOKE,
    "Electron runs on the macOS runner only",
  );
  test.setTimeout(120_000);
  const app = await electron.launch({
    args: [".", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, JARVIS_DESK_SCENARIO: "hands-on" },
  });
  try {
    const window = await app.firstWindow();
    const layer = window.locator(".hands-layer");
    await expect(layer).toHaveAttribute("data-hands-state", /tracking|error/, { timeout: 60_000 });
    const state = await layer.getAttribute("data-hands-state");
    let line = `Camera hands: ${state}, ${await layer.getAttribute("data-hands-error")} (no CPU reading)`;
    if (state === "tracking") {
      await app.evaluate(({ app }) => app.getAppMetrics()); // starts the CPU interval
      await window.waitForTimeout(10_000);
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
      const cpu = metrics.reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0);
      const byType = metrics.map((m) => `${m.type} ${m.cpu.percentCPUUsage.toFixed(1)}%`).join(", ");
      line = `Camera hands tracking for 10 s: ${cpu.toFixed(1)}% CPU (${byType})`;
    }
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    // Not asserted: a CI VM may refuse the camera; the reason is in the summary line.
  } finally {
    await app.close();
  }
});
