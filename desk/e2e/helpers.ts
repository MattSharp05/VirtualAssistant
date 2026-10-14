// Shared e2e helpers: open one Desk window in the web preview on a scenario, wait for the mock
// bridge's timeline to play out, and take visual snapshots when VISUAL=1.
import { expect, type Page } from "@playwright/test";

export async function openWindow(page: Page, id: string, scenario = "demo-day"): Promise<void> {
  await page.goto(`/index.html?scenario=${encodeURIComponent(scenario)}&window=${encodeURIComponent(id)}`);
  await expect(page.locator("#root > *")).toBeVisible();
}

/** Waits until every timed event and chat chunk of the scenario has been delivered. */
export async function waitForBridgeIdle(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    () => (globalThis as { __deskMock?: { pending(): number } }).__deskMock?.pending() === 0,
    undefined,
    { timeout },
  );
}

/** A screenshot compared with e2e/__snapshots__ (0.2% tolerance), only in the visual job. */
export async function expectWindowSnapshot(page: Page, name: string): Promise<void> {
  if (process.env.VISUAL !== "1") return;
  await expect(page).toHaveScreenshot(`${name}.png`, { animations: "disabled" });
}
