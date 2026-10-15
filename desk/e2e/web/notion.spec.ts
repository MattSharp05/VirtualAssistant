import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

const side = (page: Page) => page.getByRole("complementary", { name: "Notion pages" });
const section = (page: Page, name: RegExp) => side(page).getByRole("region", { name });
const requests = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as { __deskMock?: { requests: { path: string; body?: unknown }[] } }).__deskMock!.requests,
  );

test("notion: the last page opens with headings, bullets and read-only to-dos", async ({ page }) => {
  await openWindow(page, "notion", "notion");
  await expect(page.getByRole("heading", { name: "Mario Kart PRD", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Three tracks: Harbour, Canyon, Night City" }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Lap counter and timer" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Drift boost tuning (MK-81)" })).not.toBeChecked();
  await expect(section(page, /PINNED/).getByRole("button")).toHaveText([
    "JARVIS Tasksdatabase",
    "JARVIS Memory",
    "Mario Kart PRD",
  ]);
  await expect(section(page, /RECENT/).getByRole("button")).toHaveText([
    "Trip v1 · Ticketsdatabase",
    "Process Journal",
    "Shapemint TDD",
    "Claude Projects",
  ]);
  await waitForBridgeIdle(page);
  await expectWindowSnapshot(page, "notion");
});

test("notion: search filters results and opens one; child pages open inside the window", async ({ page }) => {
  await openWindow(page, "notion", "notion");
  await expect(page.getByRole("heading", { name: "Mario Kart PRD", level: 2 })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search Notion" });
  await search.fill("PRD");
  const results = section(page, /RESULTS/);
  await expect(results.getByRole("button")).toHaveText([
    "Mario Kart PRD",
    "Trip planner PRD",
    "Shapemint PRD",
  ]);
  await search.fill("trip");
  await expect(results.getByRole("button")).toHaveText(["Trip v1 · Ticketsdatabase", "Trip planner PRD"]);
  await expectWindowSnapshot(page, "notion-search");
  await results.getByRole("button", { name: "Trip planner PRD" }).click();
  await expect(page.getByRole("heading", { name: "Trip planner PRD", level: 2 })).toBeVisible();

  // Escape clears the search; a child page opens in place and Back returns.
  await search.press("Escape");
  await section(page, /PINNED/)
    .getByRole("button", { name: "Mario Kart PRD" })
    .click();
  await page.getByRole("button", { name: "Track list" }).click();
  await expect(page.getByRole("heading", { name: "Track list", level: 2 })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Canyon" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Mario Kart PRD", level: 2 })).toBeVisible();
});

test("notion: pin and unpin call the server; Ask JARVIS sends the page; Full view placeholder", async ({
  page,
}) => {
  await openWindow(page, "notion", "notion");
  await page.getByRole("button", { name: "Pinned" }).click();
  await expect(section(page, /PINNED/).getByRole("button")).toHaveCount(2);
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(section(page, /PINNED/).getByRole("button")).toHaveCount(3);
  const paths = (await requests(page)).map((r) => r.path);
  expect(paths).toContain("/notion/pinned/3f924983f3ca81000000000000000003/unpin");
  expect(paths).toContain("/notion/pinned/3f924983f3ca81000000000000000003");

  await page.getByRole("button", { name: "Ask JARVIS about this page" }).click();
  await expect(page.getByRole("status")).toHaveText("Asked JARVIS about “Mario Kart PRD”. Open Chat");
  await page.getByRole("tab", { name: "Full view (notion.so, editable)" }).click();
  await expect(page.getByRole("link", { name: "Open “Mario Kart PRD” in Notion" })).toBeVisible();
  await waitForBridgeIdle(page);
});

test("notion is keyboard reachable: search, pages, tabs, pin and ask", async ({ page }) => {
  await openWindow(page, "notion", "notion");
  await expect(page.getByRole("heading", { name: "Mario Kart PRD", level: 2 })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search Notion" }).focus();
  await page.keyboard.press("Tab");
  await expect(section(page, /PINNED/).getByRole("button", { name: /JARVIS Tasks/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "JARVIS Memory", level: 2 })).toBeVisible();
  await page.getByRole("tab", { name: "Read view" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tab", { name: /Full view/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Pinned" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Ask JARVIS about this page" })).toBeFocused();
});

test("notion-off: search explains Notion isn't connected", async ({ page }) => {
  await openWindow(page, "notion", "notion-off");
  await expect(page.getByText("Search, or pick a page on the left.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search Notion" }).fill("PRD");
  await expect(page.getByText(/NOTION_TOKEN is not set/)).toBeVisible();
  await expectWindowSnapshot(page, "notion-off");
});
