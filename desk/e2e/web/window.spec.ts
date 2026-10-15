import { expect, test } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

test("clicking the orb shows the six launcher buttons; Esc hides them", async ({ page }) => {
  await openWindow(page, "overlay", "orb-idle");
  const buttons = page.locator("[data-launcher-id]");
  await expect(buttons).toHaveCount(0);
  await page.locator("[data-orb-state]").click();
  await expect(buttons).toHaveCount(6);
  for (const name of ["Chat", "Sessions", "Today", "To-do", "Notion", "System"])
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  // Every button is on screen.
  for (const box of await buttons.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON())))
    expect(box.x >= 0 && box.y >= 0 && box.right <= 1440 && box.bottom <= 900).toBe(true);
  await page.keyboard.press("Escape");
  await expect(buttons).toHaveCount(0);
});

test("a launcher button asks for its window", async ({ page }) => {
  await openWindow(page, "overlay", "orb-idle");
  await page.locator("[data-orb-state]").click();
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(await popup).toHaveURL(/window=system/);
  await expect(page.locator("[data-launcher-id]")).toHaveCount(0);
});

test("launcher-open: the ring around the orb", async ({ page }) => {
  await openWindow(page, "overlay", "launcher-open");
  await waitForBridgeIdle(page);
  await expect(page.locator("[data-launcher-id]")).toHaveCount(6);
  await expectWindowSnapshot(page, "launcher-open");
});

test("?window=hello shows the frame with title, minimise and close, keyboard reachable", async ({ page }) => {
  await openWindow(page, "hello", "empty");
  await expect(page.getByRole("heading", { name: "Hello" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Minimise" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Enter");
  const actions = await page.evaluate(
    () => (globalThis as { __deskMock?: { frameActions: string[] } }).__deskMock?.frameActions,
  );
  expect(actions).toEqual(["close"]);
  await expectWindowSnapshot(page, "window-hello");
});
