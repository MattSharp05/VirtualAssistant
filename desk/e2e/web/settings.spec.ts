import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

const SECTIONS = [
  "Connection",
  "Voice",
  "Hotkeys",
  "Wake word",
  "Folders",
  "Faces & status files",
  "Updates",
];

test("settings: every section renders with the saved values", async ({ page }) => {
  await openWindow(page, "settings", "settings");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  for (const name of SECTIONS) await expect(page.getByRole("heading", { name, level: 2 })).toBeAttached();
  await expect(page.getByLabel("Server URL")).toHaveValue("https://jarvis.tail1234.ts.net:8443");
  await expect(page.getByText("Connected as Matthew's MacBook Pro")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Voice" })).toHaveValue("Daniel");
  await expect(page.getByRole("button", { name: "Play sample" })).toBeVisible();
  await expect(page.getByLabel("Double-tap right Option")).toBeChecked();
  await expect(page.getByRole("switch", { name: /Listen for/ })).toBeChecked();
  await expect(page.getByRole("link", { name: "console.picovoice.ai" })).toHaveAttribute(
    "href",
    "https://console.picovoice.ai/",
  );
  await expect(page.getByRole("list", { name: "Folders JARVIS can read" }).getByRole("listitem")).toHaveCount(
    2,
  );
  await expect(page.getByRole("switch", { name: /Check for updates/ })).toBeChecked();
  await expectWindowSnapshot(page, "settings");
});

test("settings: Test connection shows the device name from the mock", async ({ page }) => {
  await openWindow(page, "settings", "settings");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status", { name: "Test result" })).toHaveText(
    "Connected as Matthew's MacBook Pro",
  );
});

test("settings-offline: Test connection shows why it failed", async ({ page }) => {
  await openWindow(page, "settings", "settings-offline");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status", { name: "Test result" })).toHaveText(
    "Couldn't reach jarvis.tail1234.ts.net:8443 (ECONNREFUSED).",
  );
  await expectWindowSnapshot(page, "settings-offline");
});

test("settings-first-run: paste the URL and key, then connect", async ({ page }) => {
  await openWindow(page, "settings", "settings-first-run");
  await expect(page.getByText("Not paired yet")).toBeVisible();
  await expectWindowSnapshot(page, "settings-first-run");
  const url = page.getByLabel("Server URL");
  await url.fill("not a url");
  await url.press("Enter");
  await expect(page.getByRole("alert")).toContainText("isn't a URL");
  await url.fill("https://jarvis.tail1234.ts.net:8443/");
  await url.press("Enter");
  await expect(url).toHaveValue("https://jarvis.tail1234.ts.net:8443");
  await page.getByRole("button", { name: "Paste device key" }).click();
  await expect(page.getByText("Stored in Keychain")).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status", { name: "Test result" })).toHaveText(
    "Connected as Matthew's MacBook Pro",
  );
});

test("settings: the section list jumps, and controls are keyboard reachable", async ({ page }) => {
  await openWindow(page, "settings", "settings");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Updates" })
    .click();
  await expect(page.getByRole("heading", { name: "Updates" })).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Faces & status files" })).toBeInViewport();
  await expectWindowSnapshot(page, "settings-bottom");
  await page.getByRole("button", { name: "Add folder…" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("/Users/matthew/Desktop/Receipts")).toBeVisible();
  const voice = page.getByRole("combobox", { name: "Voice" });
  await voice.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Play sample" })).toBeFocused();
  await page.keyboard.press("Enter");
  const spoken = await page.evaluate(
    () => (globalThis as { __deskMock?: { mac: { spoken: { voice: string }[] } } }).__deskMock?.mac.spoken,
  );
  expect(spoken?.[0]?.voice).toBe("Daniel");
});

const appActions = (page: Page) =>
  page.evaluate(() => (globalThis as { __deskMock?: { appActions: string[] } }).__deskMock?.appActions);

test("settings: Show in Dock switches, and Quit JARVIS Desk quits (JD-62)", async ({ page }) => {
  await openWindow(page, "settings", "settings");
  await waitForBridgeIdle(page);
  const dock = page.getByRole("switch", { name: /Show in Dock/ });
  await expect(dock).toBeChecked();
  await dock.click();
  await expect(dock).not.toBeChecked();
  expect(
    await page.evaluate(() =>
      (
        globalThis as { __deskMock?: { settings: { get(k: string): Promise<unknown> } } }
      ).__deskMock?.settings.get("showInDock"),
    ),
  ).toBe(false);
  const quit = page.getByRole("button", { name: "Quit JARVIS Desk" });
  await quit.scrollIntoViewIfNeeded();
  await expectWindowSnapshot(page, "settings-quit");
  expect(await appActions(page)).toEqual([]);
  await quit.focus();
  await page.keyboard.press("Enter");
  expect(await appActions(page)).toEqual(["quit"]);
});

test("settings-dock-off: Show in Dock starts off", async ({ page }) => {
  await openWindow(page, "settings", "settings-dock-off");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("switch", { name: /Show in Dock/ })).not.toBeChecked();
});
