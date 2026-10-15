import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// "Checked 09:20:00" is the Mac's own time; pin it so text and snapshots don't depend on the runner.
test.use({ timezoneId: "Europe/London", locale: "en-GB" });

const AMBER = "rgb(242, 178, 76)";
const RED = "rgb(242, 104, 92)";

const fill = (page: Page, name: string) => page.getByRole("meter", { name }).locator(".system-fill");

test("system: meters show the scenario's numbers and colours (75% amber, 92% red)", async ({ page }) => {
  await openWindow(page, "system", "system");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("heading", { name: "System", exact: true })).toBeVisible();
  await expect(page.getByText("Checked 09:20:00 · refreshes every 15 s")).toBeVisible();

  const five = page.getByRole("meter", { name: "5-hour window" });
  await expect(five).toHaveAttribute("aria-valuenow", "75");
  await expect(fill(page, "5-hour window")).toHaveCSS("background-color", AMBER);
  await expect(fill(page, "5-hour window")).toHaveAttribute("style", "width: 75%;");
  const weekly = page.getByRole("meter", { name: "Weekly" });
  await expect(weekly).toHaveAttribute("aria-valuenow", "92");
  await expect(fill(page, "Weekly")).toHaveCSS("background-color", RED);
  await expect(page.locator(".system-plan")).toContainText("75%");
  await expect(page.locator(".system-plan")).toContainText("92%");
  await expect(page.getByText("resets in 2 h 10 min")).toBeVisible();

  await expect(page.locator(".system-fires")).toContainText("24 / 30");
  await expect(fill(page, "New cloud jobs")).toHaveCSS("background-color", AMBER);
  await expect(page.getByText("412 MB of 1.0 GB")).toBeVisible();
  await expect(fill(page, "Memory")).toHaveCSS("background-color", "rgb(95, 212, 230)");
  await expect(page.getByRole("img", { name: /^Memory over the last hour/ })).toBeVisible();
  await expect(page.getByRole("img", { name: "Worker 31% of today's tokens, chat 69%" })).toBeVisible();
  await expect(page.getByText("Matthew's MacBook Pro")).toBeVisible();
  await expectWindowSnapshot(page, "system");
});

test("system: Refresh now asks the server again", async ({ page }) => {
  await openWindow(page, "system", "system");
  await expect(page.getByRole("meter", { name: "Weekly" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh now" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as unknown as { __deskMock: { requests: { path: string }[] } }
          ).__deskMock.requests.filter((r) => r.path === "/system").length,
      ),
    )
    .toBe(2);
});

test("system: a fresh container with nothing reported", async ({ page }) => {
  await openWindow(page, "system", "system-quiet");
  await waitForBridgeIdle(page);
  await expect(page.getByText("This login doesn't report plan limits.")).toBeVisible();
  await expect(page.getByText("No routine set up (ROUTINE_ID)")).toBeVisible();
  await expect(page.getByText("History builds up while JARVIS runs.")).toBeVisible();
  await expect(page.getByText("No Macs paired.")).toBeVisible();
  await expectWindowSnapshot(page, "system-quiet");
});

test("system: loading", async ({ page }) => {
  await openWindow(page, "system", "system-loading");
  await expect(page.getByText("Loading…")).toBeVisible();
  await expect(page.getByRole("meter")).toHaveCount(0);
});
