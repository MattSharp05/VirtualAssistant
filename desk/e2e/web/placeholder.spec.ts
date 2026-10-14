import { expect, test } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

test("the placeholder window renders on demo-day and replays its events", async ({ page }) => {
  await openWindow(page, "home", "demo-day");
  await expect(page.getByRole("heading", { name: "JARVIS Desk" })).toBeVisible();
  await expect(page.getByTestId("scenario")).toContainText("demo-day");
  await waitForBridgeIdle(page);
  await expect(page.getByTestId("scenario")).toContainText("notice: mk merged MK-74");
  await expectWindowSnapshot(page, "home-demo-day");
});

test("dev.html links every scenario to its windows", async ({ page }) => {
  await page.goto("/dev.html");
  await expect(page.getByRole("heading", { name: "demo-day" })).toBeVisible();
  // Every scenario links each window: the placeholder and the overlay at least.
  const scenarios = await page.getByRole("heading", { level: 2 }).count();
  expect(scenarios).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("link", { name: "Home (placeholder)" })).toHaveCount(scenarios);
  await expect(page.getByRole("link", { name: "Overlay + orb" })).toHaveCount(scenarios);
});
