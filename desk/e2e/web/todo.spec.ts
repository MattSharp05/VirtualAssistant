import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Scenario dates are relative to the preview day; a fixed day keeps labels and snapshots stable.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T09:30:00"));
});

const suggestions = (page: Page) => page.locator(".todo-suggestion");
const panel = (page: Page) => page.getByRole("tabpanel");
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

test("todo: suggestions with sources; Add, Dismiss, Accept all; ticking moves a task to Done", async ({
  page,
}) => {
  await openWindow(page, "todo", "todo");
  await expect(page.getByRole("heading", { name: "To-do" })).toBeVisible();
  await expect(page.getByText("synced with Notion · JARVIS Tasks")).toBeVisible();
  await expect(suggestions(page)).toHaveCount(3);
  for (const source of ["Session", "Email", "Slack"])
    await expect(suggestions(page).getByText(source, { exact: true })).toBeVisible();
  await expect(tab(page, "Today")).toHaveText("Today3");
  await expectWindowSnapshot(page, "todo");

  // Add moves one into Today.
  await page.getByRole("button", { name: /^Add “Decide MK-81/ }).click();
  await expect(suggestions(page)).toHaveCount(2);
  await expect(panel(page).getByText(/Decide MK-81/)).toBeVisible();
  await expect(tab(page, "Today")).toHaveText("Today4");

  // Dismiss removes one.
  await page.getByRole("button", { name: /^Dismiss “Pick a flight/ }).click();
  await expect(suggestions(page)).toHaveCount(1);
  await expect(page.getByText("Pick a flight option for the trip")).toHaveCount(0);

  // Accept all empties the strip.
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(suggestions(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Suggested by JARVIS/ })).toHaveCount(0);

  // Ticking a task moves it to Done.
  // click, not check(): the row leaves the tab, so there is nothing left to read back.
  await page.getByRole("checkbox", { name: "Done: Review shapemint build failure" }).click();
  await expect(panel(page).getByText("Review shapemint build failure")).toHaveCount(0);
  await expect(tab(page, "Done")).toHaveText("Done3");
  await tab(page, "Done").click();
  await expect(page.getByRole("checkbox", { name: "Done: Review shapemint build failure" })).toBeChecked();
  await waitForBridgeIdle(page);
});

test("todo-error: a failed tick rolls the checkbox back and shows an error line", async ({ page }) => {
  await openWindow(page, "todo", "todo-error");
  const box = page.getByRole("checkbox", { name: "Done: Review shapemint build failure" });
  await box.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn't mark it done (“Review shapemint build failure”): Notion didn't answer (502 Bad Gateway).",
  );
  await expect(box).not.toBeChecked();
  await expect(tab(page, "Done")).toHaveText("Done2");
  // A failed Add puts the suggestion back too.
  await page.getByRole("button", { name: /^Add “Decide MK-81/ }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't add the suggestion");
  await expect(suggestions(page)).toHaveCount(3);
  await expectWindowSnapshot(page, "todo-error");
});

test("todo: By project groups tasks; add box adds plain text and hands dates to JARVIS", async ({ page }) => {
  await openWindow(page, "todo", "todo");
  await tab(page, "By project").click();
  for (const project of ["JARVIS Desk", "Personal", "Shapemint", "Trip", "No project"])
    await expect(page.getByRole("heading", { name: project, exact: true })).toBeVisible();
  await expectWindowSnapshot(page, "todo-by-project");

  const input = page.getByRole("textbox", { name: "Add a task" });
  await input.fill("Buy milk");
  await input.press("Enter");
  await tab(page, "Upcoming").click();
  await expect(panel(page).getByText("Buy milk")).toBeVisible();

  await input.fill("call Sam on Friday");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Asked JARVIS: “add call Sam on Friday”");
  await waitForBridgeIdle(page);
});

test("JD-83: a Notion QA to-do shows a QA badge; expanding pulls in the checklist read-only with a Notion deep link", async ({
  page,
}) => {
  await openWindow(page, "todo", "todo");
  await tab(page, "By project").click();
  const row = page.locator(".todo-row-wrap", { hasText: "QA TR-91: Confirm hotel cancellation policy" });
  await expect(row.locator(".todo-qa-badge")).toHaveText("QA");
  await expect(row.getByText(/Cancelling inside 24h/)).toHaveCount(0);

  await row.getByRole("button", { name: /^Show details/ }).click();
  const box = row.getByLabel(/Cancelling inside 24h/);
  await expect(box).toBeVisible();
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  const ticketLink = row.getByRole("link", { name: "Open ticket in Notion" });
  await expect(ticketLink).toHaveAttribute("href", /notion\.so/);

  // A to-do without a Notion QA source shows no QA panel.
  const plainRow = page.locator(".todo-row-wrap", { hasText: "Call the bank about the card limit" });
  await plainRow.getByRole("button", { name: /^Show details/ }).click();
  await expect(plainRow.getByText("Acceptance criteria")).toHaveCount(0);
});

test("JD-83: a row's Chat and Session actions mirror Ideas, closing the pop-up and adding to its history", async ({
  page,
}) => {
  await openWindow(page, "todo", "todo");
  await tab(page, "By project").click();
  const row = page.locator(".todo-row-wrap", { hasText: "Call the bank about the card limit" });
  await row.getByRole("button", { name: /^Show details/ }).click();

  await row.getByRole("button", { name: /^Chat with JARVIS/ }).hover();
  const chat = row.getByRole("dialog", { name: "Chat with JARVIS" });
  await expect(chat).toBeVisible();
  await chat.getByRole("button", { name: "Go" }).click();
  await expect(chat).toHaveCount(0);
  await expect(row.getByText(/Opened in Chat/)).toBeVisible();

  await row.getByRole("button", { name: /^Start a session/ }).hover();
  await row.getByRole("textbox", { name: "Start a session: extra context" }).fill("spike it");
  await page.keyboard.press("Enter");
  await expect(row.getByRole("link", { name: /Session started/ })).toHaveAttribute(
    "href",
    /claude\.ai\/code\/session_/,
  );
  await waitForBridgeIdle(page);
});

test("todo is keyboard reachable: tabs, suggestion buttons, checkboxes", async ({ page }) => {
  await openWindow(page, "todo", "todo");
  await page.getByRole("link", { name: "Open JARVIS Tasks in Notion" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Accept all" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Source: Session (opens it)" }).first()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /^Add “Decide MK-81/ })).toBeFocused();
  await tab(page, "Upcoming").focus();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Upcoming")).toHaveAttribute("aria-selected", "true");
});
