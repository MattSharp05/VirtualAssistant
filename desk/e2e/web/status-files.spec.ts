import { expect, test } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

test("settings: Faces → Test cycles the status files, keyboard first", async ({ page }) => {
  await openWindow(page, "settings", "settings");
  await waitForBridgeIdle(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Faces & status files" })
    .click();
  const test = page.getByRole("button", { name: "Test status files" });
  await expect(test).toBeEnabled();
  await test.focus();
  await page.keyboard.press("Enter");
  const result = page.getByRole("status", { name: "Status files test" });
  await expect(result).toHaveText("Sent idle → listening → thinking → speaking.");
  const runs = await page.evaluate(
    () => (globalThis as { __deskMock?: { mac: { statusTests: number } } }).__deskMock?.mac.statusTests,
  );
  expect(runs).toBe(1);
  await expectWindowSnapshot(page, "settings-status-files");
});

test("settings-first-run: Test waits for a status folder", async ({ page }) => {
  await openWindow(page, "settings", "settings-first-run");
  await expect(page.getByRole("button", { name: "Test status files" })).toBeDisabled();
  await expect(page.getByText("Choose a folder to test.")).toBeAttached();
});
