import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Timer ends are relative to page load; a fixed clock keeps the countdown at 4:12.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T09:12:00Z"));
});

const mock = <T>(page: Page, key: string) =>
  page.evaluate(
    (k) => (globalThis as unknown as { __deskMock: Record<string, unknown> }).__deskMock[k],
    key,
  ) as Promise<T>;

test("cards: agenda, session alert and timer beside the orb; Dismiss removes one; Pop out opens Today", async ({
  page,
}) => {
  await openWindow(page, "overlay", "cards");
  await waitForBridgeIdle(page);
  const stack = page.getByRole("region", { name: "Cards from JARVIS" });
  const cards = stack.getByRole("article");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute("aria-label", "Timer: Tea");
  await expect(stack.getByRole("timer")).toHaveText("4:12");
  await expect(cards.nth(1)).toHaveAttribute("data-level", "alert");
  await expect(stack.getByRole("button", { name: "Open session" })).toBeVisible();
  await expect(stack.getByRole("button", { name: "Later" })).toBeVisible();
  await expect(cards.nth(2).getByText("Lunch with Sam")).toBeVisible();
  await expectWindowSnapshot(page, "cards");

  // Hovering a card makes it clickable; clicks pass through elsewhere.
  await cards.nth(2).hover();
  expect(await mock<boolean>(page, "interactive")).toBe(true);
  await page.mouse.move(300, 600);
  expect(await mock<boolean>(page, "interactive")).toBe(false);

  await stack.getByRole("button", { name: "Later" }).click();
  await expect(cards).toHaveCount(2);
  await stack.getByRole("button", { name: "Pop out Today" }).click();
  await expect(cards).toHaveCount(1);
  expect(await mock<string[]>(page, "opened")).toEqual(["today"]);
});

test("cards are keyboard reachable", async ({ page }) => {
  await openWindow(page, "overlay", "cards");
  await waitForBridgeIdle(page);
  await page.getByRole("button", { name: "Dismiss timer Tea" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Cards from JARVIS" }).getByRole("article")).toHaveCount(2);
});

test("cards-dnd: a notice adds to the orb's badge instead of showing; the card he asked for still shows", async ({
  page,
}) => {
  await openWindow(page, "overlay", "cards-dnd");
  await waitForBridgeIdle(page);
  const cards = page.getByRole("region", { name: "Cards from JARVIS" }).getByRole("article");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("aria-label", "Flights to Lisbon");
  const badge = page.getByRole("button", { name: /held by Do Not Disturb/ });
  await expect(badge).toHaveText("2");
  await expectWindowSnapshot(page, "cards-dnd");
  await badge.click();
  await expect(cards).toHaveCount(3);
  await expect(badge).toHaveCount(0);
});

test("cards-voice: You said, the agenda card and the spoken caption", async ({ page }) => {
  await openWindow(page, "overlay", "cards-voice");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("complementary", { name: "You said" })).toContainText(
    "Jarvis, what's on today?",
  );
  await expect(page.getByRole("complementary", { name: "JARVIS (spoken)" })).toContainText(
    "mk needs a decision from you.",
  );
  await expectWindowSnapshot(page, "cards-voice");
});

test("cards-shown: text with markdown and a link, a list and a session card (Pop out → Sessions)", async ({
  page,
}) => {
  await openWindow(page, "overlay", "cards-shown");
  await waitForBridgeIdle(page);
  const stack = page.getByRole("region", { name: "Cards from JARVIS" });
  await expect(stack.getByRole("article")).toHaveCount(3);
  await expect(stack.getByRole("link", { name: /Open the trip PRD/ })).toHaveAttribute(
    "href",
    "https://www.notion.so/trip-prd",
  );
  await expect(stack.getByText("£135")).toBeVisible();
  await expect(stack.getByRole("button", { name: "Pop out Groceries" })).toHaveCount(0);
  await expectWindowSnapshot(page, "cards-shown");
  await stack.getByRole("button", { name: "Pop out mk" }).click();
  expect(await mock<string[]>(page, "opened")).toEqual(["sessions"]);
});

test("cards-notices: warn and info colours, and a finished timer without a duplicate notice", async ({
  page,
}) => {
  await openWindow(page, "overlay", "cards-notices");
  await waitForBridgeIdle(page);
  const cards = page.getByRole("region", { name: "Cards from JARVIS" }).getByRole("article");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute("data-level", "done");
  await expect(cards.nth(0)).toContainText("Time's up");
  await expect(cards.nth(1)).toHaveAttribute("data-level", "warn");
  await expect(cards.nth(2)).toHaveAttribute("data-level", "info");
  await expectWindowSnapshot(page, "cards-notices");
});
