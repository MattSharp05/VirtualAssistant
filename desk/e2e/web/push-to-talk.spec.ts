import { expect, test } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Push-to-talk (JD-31) as the overlay sees it: the hotkey itself is native (unit-tested in
// main/voice); these check what its events look like beside the orb.

test("ptt-listening: the orb listens", async ({ page }) => {
  await openWindow(page, "overlay", "ptt-listening");
  await waitForBridgeIdle(page);
  await expect(page.locator("[data-orb-state]")).toHaveAttribute("data-orb-state", "listening");
});

test("ptt-asked: listening → thinking → You said and the reply → idle", async ({ page }) => {
  await openWindow(page, "overlay", "ptt-asked");
  const orb = page.locator("[data-orb-state]");
  await expect(orb).toHaveAttribute("data-orb-state", "listening");
  await expect(orb).toHaveAttribute("data-orb-state", "thinking");
  await waitForBridgeIdle(page);
  await expect(orb).toHaveAttribute("data-orb-state", "idle");
  await expect(page.getByRole("complementary", { name: "You said" })).toContainText("What's on today?");
  await expect(page.getByRole("complementary", { name: "JARVIS (spoken)" })).toContainText(
    "trip planning call at 4.",
  );
});

test("ptt-missed: a “Didn't catch that” card, dismissable", async ({ page }) => {
  await openWindow(page, "overlay", "ptt-missed");
  await waitForBridgeIdle(page);
  await expect(page.locator("[data-orb-state]")).toHaveAttribute("data-orb-state", "idle");
  const card = page.getByRole("region", { name: "Cards from JARVIS" }).getByRole("article");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("aria-label", "Didn't catch that");
  await expect(card).toContainText("Double-tap right ⌥ and try again.");
  await expectWindowSnapshot(page, "ptt-missed");
  await page.getByRole("button", { name: "Dismiss Didn't catch that" }).click();
  await expect(card).toHaveCount(0);
});

test("ptt-permission: the Input Monitoring steps and Open Settings", async ({ page }) => {
  await openWindow(page, "overlay", "ptt-permission");
  await waitForBridgeIdle(page);
  const card = page.getByRole("region", { name: "Cards from JARVIS" }).getByRole("article");
  await expect(card).toHaveAttribute("aria-label", "Let JARVIS hear your hotkey");
  await expect(card.getByText("Input Monitoring")).toBeVisible();
  const open = card.getByRole("link", { name: /Open Settings/ });
  await expect(open).toHaveAttribute(
    "href",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  );
  await open.focus();
  await expect(open).toBeFocused();
  await expectWindowSnapshot(page, "ptt-permission");
});
