import { expect, test } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

const states = [
  ["orb-idle", "idle", "green"],
  ["orb-listening", "listening", "green"],
  ["orb-thinking", "thinking", "green"],
  ["orb-speaking", "speaking", "green"],
  ["orb-mood-red", "idle", "red"],
] as const;

for (const [scenario, state, mood] of states) {
  test(`${scenario}: the orb shows ${state} (${mood})`, async ({ page }) => {
    await openWindow(page, "overlay", scenario);
    await waitForBridgeIdle(page);
    const orb = page.locator("[data-orb-state]");
    await expect(orb).toHaveAttribute("data-orb-state", state);
    await expect(orb).toHaveAttribute("data-orb-mood", mood);
    await expectWindowSnapshot(page, scenario);
  });
}

test("orb-cycle goes through all four states", async ({ page }) => {
  await openWindow(page, "overlay", "orb-cycle");
  const orb = page.locator("[data-orb-state]");
  const seen = new Set<string>();
  for (const next of ["listening", "thinking", "speaking", "idle"]) {
    await expect(orb).toHaveAttribute("data-orb-state", next, { timeout: 8000 });
    seen.add(next);
  }
  expect(seen.size).toBe(4);
});

test("hovering the orb makes it clickable; elsewhere clicks pass through", async ({ page }) => {
  await openWindow(page, "overlay", "orb-idle");
  const interactive = () =>
    page.evaluate(() => (globalThis as { __deskMock?: { interactive: boolean } }).__deskMock?.interactive);
  expect(await interactive()).toBe(false);
  await page.locator("[data-orb-state]").hover();
  expect(await interactive()).toBe(true);
  await page.mouse.move(400, 400);
  expect(await interactive()).toBe(false);
  // The orb sits in the top-right corner.
  const box = (await page.locator("[data-orb-state]").boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1440 - 60);
  expect(box.y).toBeLessThan(60);
});
