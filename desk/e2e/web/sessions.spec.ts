import { expect, test } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// The mock's times are relative to page load; a fixed clock and zone keep "12m" and 08:41 stable.
test.use({ timezoneId: "Europe/London" });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T09:00:00Z"));
});

const requests = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (globalThis as { __deskMock?: { requests: { path: string; body?: unknown }[] } }).__deskMock?.requests,
  );

test("sessions: three groups; selecting mk shows its activity and reports; sending says Sent to mk", async ({
  page,
}) => {
  await openWindow(page, "sessions", "sessions");
  await waitForBridgeIdle(page);
  const list = page.getByRole("navigation", { name: "Sessions" });
  for (const group of ["Needs you", "Working", "Idle"])
    await expect(list.getByRole("heading", { name: group })).toBeVisible();
  await expect(list.locator("[data-group=needs-you] [data-session-id]")).toHaveCount(2);

  await list.getByRole("button", { name: /^trip/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "trip" })).toBeVisible();
  await expect(page.locator(".sessions-pill")).toHaveText("Ready for QA");

  await list.getByRole("button", { name: /^mk\b/ }).first().click();
  await expect(page.getByRole("heading", { level: 2, name: "mk" })).toBeVisible();
  await expect(page.locator(".sessions-pill")).toHaveText("Blocked · needs you");
  await expect(page.getByText("Blocking MK-81 and asking Matthew.")).toBeVisible();
  await expect(page.getByText(/MK-79 merged · CI green/)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Full view" })).toBeDisabled();
  await expectWindowSnapshot(page, "sessions");

  await page.getByLabel("Message mk").fill("Go with (a), cap at 1.2×");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Sent to mk");
  expect((await requests(page))?.at(-1)).toEqual({
    path: "/sessions/mk/send",
    body: { text: "Go with (a), cap at 1.2×" },
  });
});

test("sessions: ?id= selects that session; an unreadable history says so", async ({ page }) => {
  await page.goto("/index.html?scenario=sessions&window=sessions&id=notes-cleanup");
  await expect(page.getByRole("heading", { level: 2, name: "notes-cleanup" })).toBeVisible();
  await expect(page.getByText(/Live activity isn't available/)).toBeVisible();
  await expect(page.getByText("No reports from notes-cleanup yet.")).toBeVisible();
});

test("sessions: the list is keyboard reachable and filters as you type", async ({ page }) => {
  await openWindow(page, "sessions", "sessions");
  await page.getByLabel("Filter sessions").fill("shapemint");
  const rows = page.locator("[data-session-id]");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Tab"); // refresh
  await page.keyboard.press("Tab"); // the one row left
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { level: 2, name: "ShapeMint: refactor export pipeline" }),
  ).toBeVisible();
});

test("sessions-empty: nothing tracked yet", async ({ page }) => {
  await openWindow(page, "sessions", "sessions-empty");
  await waitForBridgeIdle(page);
  await expect(page.getByText("No sessions yet")).toBeVisible();
  await expectWindowSnapshot(page, "sessions-empty");
});
