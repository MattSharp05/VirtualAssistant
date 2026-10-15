import { expect, test } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

test("screen-look: the 📸 card shows beside the orb with the spoken answer", async ({ page }) => {
  await openWindow(page, "overlay", "screen-look");
  await waitForBridgeIdle(page);
  const cards = page.getByRole("region", { name: "Cards from JARVIS" }).getByRole("article");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("aria-label", "📸 Looked at your screen");
  await expect(cards.first()).toContainText("One screenshot of this display, because you asked.");
  await expect(page.getByRole("complementary", { name: "JARVIS (spoken)" })).toContainText(
    "hotel cap is still blank.",
  );
  await expectWindowSnapshot(page, "screen-look");
  await page.getByRole("button", { name: /Dismiss/ }).click();
  await expect(cards).toHaveCount(0);
});

test("clipboard-read: the 📋 card shows beside the orb", async ({ page }) => {
  await openWindow(page, "overlay", "clipboard-read");
  await waitForBridgeIdle(page);
  const cards = page.getByRole("region", { name: "Cards from JARVIS" }).getByRole("article");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("aria-label", "📋 Read your clipboard");
});
