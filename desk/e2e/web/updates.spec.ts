// Automatic updates (JD-74): the "ready to install" notice beside the orb, the card after an update,
// and Settings → Install updates automatically.
import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

/** window.open, recorded instead of opening a tab (in the app, main hands these links to the updater). */
async function recordOpens(page: Page) {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (globalThis as unknown as { __opened: string[] }).__opened = opened;
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
  });
  return () => page.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
}

test("update ready: Restart now hands the restart link over, Later just dismisses", async ({ page }) => {
  const opened = await recordOpens(page);
  await openWindow(page, "overlay", "update-ready");
  await waitForBridgeIdle(page);
  const stack = page.getByRole("region", { name: "Cards from JARVIS" });
  const card = stack.getByRole("article");
  await expect(card).toHaveCount(1);
  await expect(card.getByText("JARVIS Desk 1.3.0 is ready")).toBeVisible();
  await expect(card.getByText(/installs itself when you quit/)).toBeVisible();
  await expect(card.getByRole("button")).toHaveText(["Restart now", "Later"]);
  await expectWindowSnapshot(page, "update-ready");
  await card.getByRole("button", { name: "Restart now" }).click();
  expect(await opened()).toEqual([
    "https://github.com/MattSharp05/VirtualAssistant/releases/tag/desk-v1.3.0#jarvis-desk-restart",
  ]);
  await expect(card).toHaveCount(0);

  await page.reload();
  await waitForBridgeIdle(page);
  await stack.getByRole("button", { name: "Later" }).click();
  await expect(stack.getByRole("article")).toHaveCount(0);
  expect(await opened()).toEqual([]);
});

test("after an update: Updated to 1.3.0 with the release notes", async ({ page }) => {
  await openWindow(page, "overlay", "update-installed");
  await waitForBridgeIdle(page);
  const card = page.getByRole("region", { name: "Cards from JARVIS" }).getByRole("article");
  await expect(card.getByText("Updated to 1.3.0")).toBeVisible();
  await expect(card.getByRole("link", { name: "Release notes" })).toHaveAttribute(
    "href",
    "https://github.com/MattSharp05/VirtualAssistant/releases/tag/desk-v1.3.0",
  );
});

const setting = (page: Page, key: string) =>
  page.evaluate(
    (k) =>
      (
        globalThis as { __deskMock?: { settings: { get(k: string): Promise<unknown> } } }
      ).__deskMock?.settings.get(k),
    key,
  );

test("settings: Install updates automatically is on by default and turns off", async ({ page }) => {
  await openWindow(page, "settings", "settings");
  await waitForBridgeIdle(page);
  const toggle = page.getByRole("switch", { name: /Install updates automatically/ });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await setting(page, "autoInstallUpdates")).toBe(false);

  await openWindow(page, "settings", "settings-auto-update-off");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("switch", { name: /Install updates automatically/ })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: /Check for updates/ })).toBeChecked();
});
