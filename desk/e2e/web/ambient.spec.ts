import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// The scenario starts the face's clock at 09:00 London; the mock's session times are relative to page
// load, so a fixed clock and zone keep "1 min ago" stable.
test.use({ timezoneId: "Europe/London", locale: "en-GB" });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T08:00:00Z"));
});

const frameActions = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as { __deskMock: { frameActions: string[] } }).__deskMock.frameActions,
  );

test("ambient: clock, next event, counts and meters from the scenario", async ({ page }) => {
  await openWindow(page, "ambient", "ambient");
  await waitForBridgeIdle(page);
  await expect(page.getByTestId("ambient-clock")).toHaveText("09:00");
  await expect(page.getByText("Wednesday 14 October")).toBeVisible();
  await expect(page.getByTestId("ambient-next")).toContainText("Standup · 09:30");
  await expect(page.getByTestId("ambient-next")).toContainText("in 30 min");
  await expect(page.getByTestId("ambient-todo")).toContainText("2 open");
  const sessions = page.getByTestId("ambient-sessions");
  for (const [label, n] of [
    ["Working", "2"],
    ["Waiting on you", "1"],
    ["Blocked", "1"],
  ])
    await expect(sessions.locator(".ambient-count", { hasText: label }).locator("dd")).toHaveText(n);
  await expect(page.getByRole("meter", { name: "5-hour plan usage" })).toHaveAttribute("aria-valuenow", "42");
  await expect(page.getByRole("meter", { name: "Weekly plan usage" })).toHaveAttribute("aria-valuenow", "18");
  await expect(page.getByTestId("ambient-plan")).toContainText("5-hour · 42%");
  await expect(page.getByTestId("ambient-plan")).toContainText("Weekly · 18%");
  await expect(page.getByTestId("ambient-report")).toHaveText(
    "Last report · mk-80-builder · 1 min ago · MK-80 · track hazards · running tests",
  );
  await expect(page.getByRole("button", { name: "JARVIS (idle)" })).toHaveAttribute("data-orb-mood", "red");
  await expect(page.getByTestId("ambient-state")).toHaveText("Ready");
  await expectWindowSnapshot(page, "ambient");
});

test("ambient: the large orb follows JARVIS speaking", async ({ page }) => {
  await openWindow(page, "ambient", "ambient-speaking");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("button", { name: "JARVIS (speaking)" })).toHaveAttribute(
    "data-orb-expanded",
    "true",
  );
  await expect(page.getByTestId("ambient-state")).toHaveText("Speaking");
  await expectWindowSnapshot(page, "ambient-speaking");
});

test("ambient: a quiet day with the plan unavailable", async ({ page }) => {
  await openWindow(page, "ambient", "ambient-quiet");
  await waitForBridgeIdle(page);
  await expect(page.getByTestId("ambient-next")).toContainText("Nothing else today");
  await expect(page.getByTestId("ambient-todo")).toContainText("0 open");
  await expect(page.getByTestId("ambient-plan")).toContainText("Plan usage unavailable");
  await expect(page.getByTestId("ambient-report")).toHaveText("No reports yet");
  await expectWindowSnapshot(page, "ambient-quiet");
});

test("ambient: Esc and the close button close the face", async ({ page }) => {
  await openWindow(page, "ambient", "ambient");
  await waitForBridgeIdle(page);
  await page.keyboard.press("Escape");
  await expect.poll(() => frameActions(page)).toEqual(["close"]);
  await page.getByRole("button", { name: "Close ambient face" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => frameActions(page)).toEqual(["close", "close"]);
});
