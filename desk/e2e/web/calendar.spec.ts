import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// The calendar scenarios are London times (the demo week, 12–18 Oct 2026, is in BST).
test.use({ timezoneId: "Europe/London" });

/** Records the text of every chat the window sends (brain.start from the mock bridge). */
async function recordChats(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as {
      __chats?: string[];
      __deskMock?: { subscribe(fn: (e: { type: string; text?: string }) => void): void };
    };
    g.__chats = [];
    g.__deskMock?.subscribe((e) => e.type === "brain.start" && g.__chats!.push(e.text!));
  });
}

const chats = (page: Page) => page.evaluate(() => (globalThis as { __chats?: string[] }).__chats);

test("calendar: the demo week, day and month views, event details", async ({ page }) => {
  await openWindow(page, "calendar", "calendar");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "12 – 18 October 2026" })).toBeVisible();
  for (const name of [
    "Standup, Mon 12 Oct",
    "Investor update, Wed 14 Oct",
    "Retro, Fri 16 Oct",
    "Parkrun + brunch, Sat 17 Oct",
  ])
    await expect(
      page.getByRole("button", { name: new RegExp(`^${name.replace(/[+]/g, "\\+")}`) }),
    ).toBeVisible();
  await expect(page.getByRole("button", { name: "Office day, All day" })).toBeVisible();
  await expect(page.getByTestId("now-line")).toHaveCount(1);
  // The grid opens on 08:00; the 07:00 swim is a scroll away.
  const scroll = page.getByTestId("calendar-scroll");
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole("region", { name: "Free this week" })).toContainText("Wed 09:45 – 11:00");

  await page.getByRole("button", { name: /^Trip planning call/ }).click();
  const panel = page.getByRole("region", { name: "Selected event" });
  await expect(panel).toContainText("Trip planning call");
  await expect(panel).toContainText("Wed 14 Oct · 16:00 – 16:45");
  await expect(panel).toContainText("With Sam, Jo, Priya");
  await expect(panel.getByRole("link", { name: "Open in Notion" })).toBeVisible();
  await expectWindowSnapshot(page, "calendar-week");

  await page.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Wednesday 14 October 2026" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Investor update/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retro/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page.getByRole("heading", { name: "Thursday 15 October 2026" })).toBeVisible();
  // Deep work and the 1:1 overlap: side by side.
  const deep = await page.getByRole("button", { name: /^Deep work block/ }).boundingBox();
  const jo = await page.getByRole("button", { name: /^1:1 with Jo/ }).boundingBox();
  expect(jo!.x).toBeGreaterThanOrEqual(deep!.x + deep!.width - 1);

  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page.getByRole("heading", { name: "October 2026" })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 more on Wed 14 Oct" })).toBeVisible();
  await expectWindowSnapshot(page, "calendar-month");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.getByRole("heading", { name: "12 – 18 October 2026" })).toBeVisible();
});

test("calendar: New event sends the expected chat text", async ({ page }) => {
  await openWindow(page, "calendar", "calendar");
  await waitForBridgeIdle(page);
  await recordChats(page);
  await page.getByRole("button", { name: "New event" }).click();
  const form = page.getByRole("dialog", { name: "New event" });
  await expect(form.getByLabel("Title")).toBeFocused();
  await form.getByLabel("Title").fill("Booking call");
  await form.getByLabel("Day").fill("2026-10-16");
  await form.getByLabel("Start").fill("12:00");
  await form.getByLabel("Duration").selectOption("30");
  await form.getByLabel("Guests").fill("Sam");
  await expect(form).toContainText("Create ‘Booking call’ Fri 16 Oct 12:00 for 30 min with Sam");
  await form.getByRole("button", { name: "Ask JARVIS" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Asked JARVIS: Create ‘Booking call’");
  await expect
    .poll(() => chats(page))
    .toEqual(["Create ‘Booking call’ Fri 16 Oct 12:00 for 30 min with Sam"]);
});

test("calendar: Prep me for this asks JARVIS", async ({ page }) => {
  await openWindow(page, "calendar", "calendar");
  await waitForBridgeIdle(page);
  await recordChats(page);
  await page.getByRole("button", { name: /^Trip planning call/ }).click();
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Prep me for this" }).click();
  await expect(await popup).toHaveURL(/window=chat/);
  await expect.poll(() => chats(page)).toEqual(["prep me for Trip planning call"]);
});

test("calendar-changed: the change log shows the entry with Undo; Undo sends “undo that”", async ({
  page,
}) => {
  await openWindow(page, "calendar", "calendar-changed");
  await waitForBridgeIdle(page);
  await recordChats(page);
  const log = page.getByRole("region", { name: "Changed by JARVIS" });
  await expect(log).toContainText("Moved “Booking call” → Fri 16 Oct 12:00");
  await expect(page.getByRole("button", { name: /^Booking call, Fri 16 Oct/ })).toBeVisible();
  await expectWindowSnapshot(page, "calendar-changed");
  const undo = log.getByRole("button", { name: "Undo: Moved “Booking call” → Fri 16 Oct 12:00" });
  await undo.click();
  await expect.poll(() => chats(page)).toEqual(["undo that"]);
  await expect(undo).toBeDisabled();
});

test("calendar-loading: a skeleton while the worker fetches", async ({ page }) => {
  await openWindow(page, "calendar", "calendar-loading");
  await waitForBridgeIdle(page);
  await expect(page.getByTestId("calendar-skeleton")).toBeVisible();
  await expect(page.getByText("Fetching your calendar…")).toBeVisible();
  await expectWindowSnapshot(page, "calendar-loading");
});

test("calendar-error: Try again", async ({ page }) => {
  await openWindow(page, "calendar", "calendar-error");
  await expect(page.getByRole("alert")).toContainText("Couldn't load the calendar");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("calendar: keyboard reaches the toolbar", async ({ page }) => {
  await openWindow(page, "calendar", "calendar");
  await waitForBridgeIdle(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Previous week" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "5 – 11 October 2026" })).toBeVisible();
});
