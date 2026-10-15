import { expect, test } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Full views (JD-39) only exist in the app; the web preview shows a placeholder card in both windows.
// The Sessions mock's times are relative to page load, so the clock and zone are fixed.
test.use({ timezoneId: "Europe/London" });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T09:00:00Z"));
});

test("sessions: Full view shows the placeholder; Quick view comes back", async ({ page }) => {
  await openWindow(page, "sessions", "sessions");
  await expect(page.getByRole("heading", { level: 2, name: "mk" })).toBeVisible();
  const full = page.getByRole("tab", { name: "Full view (claude.ai)" });
  await full.click();
  await expect(full).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Full view works in the app" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open “mk” on claude.ai" })).toHaveAttribute(
    "href",
    "https://claude.ai/code/session_01MK",
  );
  await expect(page.getByLabel("Message mk")).toHaveCount(0);
  await waitForBridgeIdle(page);
  await expectWindowSnapshot(page, "sessions-full-view");

  // Picking another session keeps Full view, on that session.
  await page.getByRole("navigation", { name: "Sessions" }).getByRole("button", { name: /^trip/ }).click();
  await expect(page.getByRole("link", { name: "Open “trip” on claude.ai" })).toBeVisible();

  await page.getByRole("tab", { name: "Quick view" }).click();
  await expect(page.getByLabel("Message trip")).toBeVisible();
});

test("notion: Full view shows the placeholder; Read view comes back", async ({ page }) => {
  await openWindow(page, "notion", "notion");
  await expect(page.getByRole("heading", { name: "Mario Kart PRD", level: 2 })).toBeVisible();
  await page.getByRole("tab", { name: "Full view (notion.so, editable)" }).click();
  await expect(page.getByRole("heading", { name: "Full view works in the app" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open “Mario Kart PRD” on notion.so" })).toHaveAttribute(
    "href",
    /^https:\/\/www\.notion\.so\//,
  );
  await waitForBridgeIdle(page);
  await expectWindowSnapshot(page, "notion-full-view");

  await page.getByRole("tab", { name: "Read view" }).click();
  await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
});

test("full view tabs are keyboard reachable", async ({ page }) => {
  await openWindow(page, "sessions", "sessions");
  await page.getByRole("tab", { name: "Quick view" }).focus();
  await page.keyboard.press("Tab");
  const full = page.getByRole("tab", { name: "Full view (claude.ai)" });
  await expect(full).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Full view works in the app" })).toBeVisible();
});
