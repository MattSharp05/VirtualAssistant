import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Times in the window are the Mac's own; pin them so text and snapshots don't depend on the runner.
test.use({ timezoneId: "Europe/London", locale: "en-GB" });

const mock = <T>(page: Page, key: "opened" | "requests") =>
  page.evaluate(
    (k) => (globalThis as unknown as Record<string, Record<string, unknown>>).__deskMock[k],
    key,
  ) as Promise<T>;

test("today: every section renders from the demo day, next-up highlighted", async ({ page }) => {
  await openWindow(page, "today", "today");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Wed 14 Oct")).toBeVisible();
  await expect(page.getByText("refreshed 09:53 by JARVIS")).toBeVisible();
  for (const name of [
    "CALENDAR",
    "INBOX · WORTH READING",
    "SLACK · MENTIONS & DMS",
    "TO-DO · DUE TODAY",
    "SESSIONS WAITING ON YOU",
  ])
    await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator("[data-next-up]")).toContainText("Lunch with Sam");
  await expect(page.locator("[data-next-up]")).toContainText("Next up · in 2 h 30 min · Dishoom");
  await expect(page.getByText("+ 14 others JARVIS skipped")).toBeVisible();
  await expect(page.getByText("Can you review the onboarding copy today?")).toBeVisible();
  await expect(page.getByText("TR-14 needs a decision: hotel budget cap?")).toBeVisible();
  await expect(page.getByRole("link", { name: "Standup" })).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("button", { name: "Play morning brief" })).toBeVisible();
  await expect(page.getByTestId("today-stale")).toHaveCount(0);
  await expectWindowSnapshot(page, "today");
});

test("today: ticking a to-do calls the mock", async ({ page }) => {
  await openWindow(page, "today", "today");
  const box = page.getByRole("checkbox", { name: /Review onboarding copy for Priya/ });
  await box.check();
  await expect(box).toBeChecked();
  await expect
    .poll(() => mock<{ path: string }[]>(page, "requests"))
    .toContainEqual({ path: "/tasks/t2/done", body: {} });
});

test("today: pop-outs open the right windows", async ({ page }) => {
  await openWindow(page, "today", "today");
  await waitForBridgeIdle(page);
  for (const name of [
    "Pop out calendar",
    "Pop out inbox",
    "Pop out Slack",
    "Open to-do window",
    "Open sessions window",
  ]) {
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name }).click();
    await (await popup).close();
  }
  expect(await mock<string[]>(page, "opened")).toEqual([
    "calendar",
    "today?section=inbox",
    "today?section=slack",
    "todo",
    "sessions",
  ]);
});

test("today: the inbox pops out into a section-only window", async ({ page }) => {
  await openWindow(page, "today", "today");
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Pop out inbox" }).click();
  const inbox = await popup;
  await expect(inbox).toHaveURL(/window=today&section=inbox/);
  await expect(inbox.getByRole("heading", { name: "INBOX · WORTH READING" })).toBeVisible();
  await expect(inbox.getByRole("heading", { name: "CALENDAR" })).toHaveCount(0);
});

test("today: refresh and the morning brief go to the server", async ({ page }) => {
  await openWindow(page, "today", "today");
  await page.getByRole("button", { name: "Play morning brief" }).click();
  await expect(page.getByRole("button", { name: "Play morning brief" })).toHaveText("Brief on its way");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("· refreshing…")).toBeVisible();
  const paths = (await mock<{ path: string; body?: unknown }[]>(page, "requests")).filter((r) => r.body);
  expect(paths.map((r) => r.path)).toEqual(["/brief", "/today/refresh"]);
});

test("today: keyboard reaches the header buttons and pop-outs", async ({ page }) => {
  await openWindow(page, "today", "today");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("button", { name: "Play morning brief" })).toBeVisible();
  const order: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
  }
  expect(order).toEqual(["Minimise", "Close", "Play morning brief", "Refresh", "Pop out calendar", ""]);
});

test("today-stale: shows the stale indicator", async ({ page }) => {
  await openWindow(page, "today", "today-stale");
  await waitForBridgeIdle(page);
  await expect(page.getByTestId("today-stale")).toHaveText("Stale · 2 h 20 min old");
  await expectWindowSnapshot(page, "today-stale");
});

test("today-empty: friendly empty states", async ({ page }) => {
  await openWindow(page, "today", "today-empty");
  await waitForBridgeIdle(page);
  for (const text of [
    "Nothing on the calendar today.",
    "Nothing worth reading right now.",
    "No mentions or DMs.",
    "Nothing due today.",
    "No session is waiting on you.",
  ])
    await expect(page.getByText(text)).toBeVisible();
  await expectWindowSnapshot(page, "today-empty");
});
