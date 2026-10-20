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

test("sessions: by project; selecting mk shows its activity and reports; sending says Sent to mk", async ({
  page,
}) => {
  await openWindow(page, "sessions", "sessions");
  await waitForBridgeIdle(page);
  const list = page.getByRole("navigation", { name: "Sessions" });
  await expect(list.getByLabel("Group")).toHaveValue("project");
  const projects = list.locator("[data-project]");
  await expect(projects).toHaveCount(5);
  expect(await projects.evaluateAll((g) => g.map((x) => x.getAttribute("data-project")))).toEqual([
    "MarioKart",
    "Trip planner",
    "ShapeMint",
    "JARVIS Desk",
    "No project",
  ]);
  const marioKart = list.locator('[data-project="MarioKart"]');
  await expect(marioKart.locator(".sessions-project-summary")).toHaveText("1 needs you · 1 working");
  await expect(marioKart.locator("[data-session-id]")).toHaveCount(2);

  await list.getByRole("button", { name: /^trip/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "trip", exact: true })).toBeVisible();
  await expect(page.locator(".sessions-pill")).toHaveText("Ready for QA");

  await list.getByRole("button", { name: /^mk\b/ }).first().click();
  await expect(page.getByRole("heading", { level: 2, name: "mk", exact: true })).toBeVisible();
  await expect(page.locator(".sessions-pill")).toHaveText("Blocked · needs you");
  await expect(page.getByText("Blocking MK-81 and asking Matthew.")).toBeVisible();
  await expect(page.getByText(/MK-79 merged · CI green/)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Full view (claude.ai)" })).toBeEnabled();
  const metrics = page.getByRole("region", { name: "Metrics" });
  await expect(metrics.getByRole("link", { name: "MarioKart #79" })).toBeVisible();
  await expect(metrics.getByText("612", { exact: true })).toBeVisible();
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
  await page.keyboard.press("Tab"); // group
  await page.keyboard.press("Tab"); // the ShapeMint project's header
  await expect(page.getByRole("button", { name: "ShapeMint", exact: true })).toBeFocused();
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

test("sessions: rows carry cost, tokens, wall time and a context bar; unknown is —", async ({ page }) => {
  await openWindow(page, "sessions", "sessions");
  await waitForBridgeIdle(page);
  const mk = page.locator('[data-session-id="mk"]');
  await expect(mk.locator("[data-metric=cost]")).toHaveText("$269.76");
  await expect(mk.locator("[data-metric=tokens]")).toHaveText("832 M");
  await expect(mk.locator("[data-metric=context]")).toHaveText("27.1%");
  await expect(page.locator('[data-session-id="virtual-assistant"] .sessions-bar')).toHaveAttribute(
    "data-tone",
    "red",
  );
  const unknown = page.locator('[data-session-id="notes-cleanup"] [data-metric=cost] .sessions-unknown');
  await expect(unknown).toHaveAttribute("title", "not reported by the API");
});

test("sessions: Most expensive and Context fullest sort the list", async ({ page }) => {
  await openWindow(page, "sessions", "sessions");
  await waitForBridgeIdle(page);
  const ids = () =>
    page.locator("[data-session-id]").evaluateAll((rows) => rows.map((r) => r.dataset.sessionId));
  await page.getByLabel("Group").selectOption({ label: "Most expensive" });
  await expect(page.getByRole("heading", { level: 2, name: "Most expensive" })).toBeVisible();
  expect(await ids()).toEqual([
    "mk",
    "trip",
    "virtual-assistant",
    "session_01SM",
    "mk-80-builder",
    "notes-cleanup",
  ]);
  await page.getByLabel("Group").selectOption({ label: "Context fullest" });
  expect((await ids())[0]).toBe("virtual-assistant");
  expect((await ids()).at(-1)).toBe("notes-cleanup");
});

test("sessions-metrics-heavy: mk's context is red, the builder's amber, and the served model differs", async ({
  page,
}) => {
  await openWindow(page, "sessions", "sessions-metrics-heavy");
  await waitForBridgeIdle(page);
  const metrics = page.getByRole("region", { name: "Metrics" });
  await expect(metrics.getByText("2,410+")).toBeVisible();
  await expect(metrics.getByText("configured claude-opus-5-5")).toBeVisible();
  await expect(metrics.locator(".sessions-bar")).toHaveAttribute("data-tone", "red");
  await expect(page.locator('[data-session-id="mk"] [data-metric=cost]')).toHaveText("$1,285");
  await expect(page.locator('[data-session-id="mk-80-builder"] .sessions-bar')).toHaveAttribute(
    "data-tone",
    "amber",
  );
  await expectWindowSnapshot(page, "sessions-metrics-heavy");
});

test("sessions: Needs you first groups by status; a project folds from its header", async ({ page }) => {
  await openWindow(page, "sessions", "sessions");
  await waitForBridgeIdle(page);
  const list = page.getByRole("navigation", { name: "Sessions" });
  const toggle = list.getByRole("button", { name: "MarioKart", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(list.locator('[data-session-id="mk-80-builder"]')).toBeHidden();
  await toggle.click();
  await expect(list.locator('[data-session-id="mk-80-builder"]')).toBeVisible();

  await list.getByLabel("Group").selectOption({ label: "Needs you first" });
  for (const group of ["Needs you", "Working", "Idle"])
    await expect(list.getByRole("heading", { name: group })).toBeVisible();
  await expect(list.locator("[data-group=needs-you] [data-session-id]")).toHaveCount(2);
});

test("sessions: Pop out opens the session in its own window", async ({ page }) => {
  await openWindow(page, "sessions", "sessions");
  await waitForBridgeIdle(page);
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Pop out mk into its own window" }).click();
  const solo = await popup;
  await expect(solo).toHaveURL(/window=sessions&solo=mk/);
  await expect(solo.getByRole("heading", { level: 1, name: "mk" })).toBeVisible();
  await solo.close();
  expect(
    await page.evaluate(() => (globalThis as { __deskMock?: { opened: string[] } }).__deskMock?.opened),
  ).toEqual(["sessions?solo=mk"]);
});

test("sessions-solo: just the session, titled with its name, and Send still works", async ({ page }) => {
  await openWindow(page, "sessions", "sessions-solo");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("heading", { level: 1, name: "mk" })).toBeVisible();
  await expect(page).toHaveTitle("mk · JARVIS");
  await expect(page.getByRole("navigation", { name: "Sessions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Pop out/ })).toHaveCount(0);
  await expect(page.getByText("Blocking MK-81 and asking Matthew.")).toBeVisible();
  await expectWindowSnapshot(page, "sessions-solo");

  await page.getByLabel("Message mk").fill("Cap it at 1.2×");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Sent to mk");
});
