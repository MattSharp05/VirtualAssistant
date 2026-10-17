import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// JD-55: cloud session cost per project, and 30 days of it per day, in the System window.
test.use({ timezoneId: "Europe/London", locale: "en-GB" });

const chart = (page: Page, metric = "Cost") =>
  page.getByRole("group", { name: `${metric} per day over the last 30 days, by project` });
const projects = (page: Page) => page.getByRole("region", { name: "PROJECTS · CLOUD SESSIONS" });

/** Scrolls the window so the chart and the table are on screen. */
async function showUsage(page: Page) {
  await page.locator(".system-history").evaluate((el) => el.scrollIntoView({ block: "start" }));
}

test("system: 30 stacked days and the projects table from the mock; hover shows the day", async ({
  page,
}) => {
  await openWindow(page, "system", "system");
  await waitForBridgeIdle(page);
  await showUsage(page);
  const days = chart(page).getByRole("img");
  await expect(days).toHaveCount(30);
  await expect(page.getByRole("list", { name: "Projects" }).getByRole("listitem")).toHaveText([
    "jarvis",
    "mario-kart",
    "shapemint",
    "trip-planner",
    "Other",
  ]);
  // The first project's bars wear series 1 (the dataviz-checked cyan), Other the grey.
  await expect(page.locator('.usage-bar [data-slot="1"]').first()).toHaveCSS("fill", "rgb(26, 156, 176)");
  await expect(page.locator('.usage-bar [data-slot="other"]').first()).toHaveCSS(
    "fill",
    "rgb(111, 122, 131)",
  );

  await expect(projects(page).getByRole("rowheader")).toHaveText([
    "mario-kart",
    "jarvis",
    "trip-planner",
    "Other",
    "shapemint",
  ]);
  await expect(projects(page).getByRole("columnheader", { name: /^Cost/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );

  await days.last().hover();
  const tip = page.locator(".usage-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Wed 14 Oct");
  await expect(tip).toContainText("jarvis");
  await expect(page.locator(".usage-bar[data-dim]")).toHaveCount(29);
  await expectWindowSnapshot(page, "system-usage");
});

test("system: tokens toggle, period toggle and sorting are buttons that work from the keyboard", async ({
  page,
}) => {
  await openWindow(page, "system", "system");
  await waitForBridgeIdle(page);
  await showUsage(page);
  const history = page.getByRole("region", { name: /^LAST 30 DAYS/ });
  await history.getByRole("button", { name: "Tokens" }).focus();
  await page.keyboard.press("Enter");
  await expect(chart(page, "Tokens")).toBeVisible();
  await expect(history.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true");
  await expect(history).toContainText(/\d+(\.\d)?M in 30 days/);

  // Tab onto a day: its numbers show without a mouse.
  await chart(page, "Tokens").getByRole("img").first().focus();
  await expect(page.locator(".usage-tip")).toBeVisible();

  const table = projects(page);
  await table.getByRole("button", { name: "All time", exact: true }).click();
  await expect(table.getByRole("rowheader").first()).toHaveText("jarvis");
  await table.getByRole("button", { name: /^Sessions/ }).click();
  await expect(table.getByRole("columnheader", { name: /^Sessions/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await table.getByRole("button", { name: /^Project/ }).click();
  await expect(table.getByRole("rowheader")).toHaveText([
    "jarvis",
    "mario-kart",
    "Other",
    "shapemint",
    "trip-planner",
  ]);
});

test("system-history: nine projects, the smallest folded into Other, and a launch spike", async ({
  page,
}) => {
  await openWindow(page, "system", "system-history");
  await waitForBridgeIdle(page);
  await showUsage(page);
  await expect(page.getByRole("list", { name: "Projects" }).getByRole("listitem")).toHaveCount(6);
  await expect(page.getByRole("list", { name: "Projects" }).getByRole("listitem").last()).toHaveText("Other");
  await expect(projects(page).getByRole("rowheader")).toHaveCount(9);
  // The launch spike is landing-site's; recipes is too small for a colour and sits in Other.
  await expect(
    chart(page).getByRole("img", { name: /^Sun 11 Oct: \$\d+\.\d\d \(.*landing-site \$/ }),
  ).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Projects" })).not.toContainText("recipes");
  await expect(projects(page).getByRole("rowheader", { name: "recipes" })).toHaveAttribute(
    "data-slot",
    "other",
  );
  await expectWindowSnapshot(page, "system-history");
});

test("system-history-empty: before the first snapshot", async ({ page }) => {
  await openWindow(page, "system", "system-history-empty");
  await waitForBridgeIdle(page);
  await showUsage(page);
  await expect(page.getByText(/No cloud session use recorded yet/)).toBeVisible();
  await expect(page.getByText("No cloud sessions recorded yet.")).toBeVisible();
  await expect(page.getByText("$0 in 30 days")).toBeVisible();
  await expectWindowSnapshot(page, "system-history-empty");
});
