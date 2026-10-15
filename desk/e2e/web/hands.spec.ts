// Camera hands (JD-42) in Chromium with its fake camera: the overlay opens the camera only while the
// setting is on, loads the bundled MediaPipe runtime + model and tracks; turning it off ends the
// camera's tracks (the light goes off). The fake video has no hands, so no pointers: manual QA.
import { expect, test } from "@playwright/test";
import { openWindow } from "../helpers";

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
  },
});

// Every camera stream the page opens, to check it's released.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const opened: MediaStream[] = [];
    (globalThis as { __streams?: MediaStream[] }).__streams = opened;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await original(c);
      opened.push(s);
      return s;
    };
  });
});

const streams = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    ((globalThis as { __streams?: MediaStream[] }).__streams ?? []).map((s) =>
      s.getTracks().map((t) => t.readyState),
    ),
  );

test("Camera hands off: no camera", async ({ page }) => {
  await openWindow(page, "overlay", "orb-idle");
  await expect(page.locator("[data-orb-state]")).toBeVisible();
  await expect(page.locator(".hands-layer")).toHaveCount(0);
  expect(await streams(page)).toEqual([]);
});

test("Camera hands on: tracks with the bundled model, and off releases the camera", async ({ page }) => {
  // Loading 12 MB of WASM and the model on a CI machine's CPU takes a while.
  test.setTimeout(120_000);
  await openWindow(page, "overlay", "hands-on");
  await expect(page.locator(".hands-layer")).toHaveAttribute("data-hands-state", "tracking", {
    timeout: 60_000,
  });
  expect(await streams(page)).toEqual([["live"]]);

  // What the tray toggle does: the setting changes and main tells the overlay.
  await page.evaluate(() =>
    (
      globalThis as { __deskMock?: { settings: { set(k: string, v: unknown): Promise<void> } } }
    ).__deskMock!.settings.set("cameraHands", false),
  );
  await expect(page.locator(".hands-layer")).toHaveCount(0);
  expect(await streams(page)).toEqual([["ended"]]);
});
