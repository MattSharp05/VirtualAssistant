import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// The mock's times are relative to page load; a fixed clock and zone keep "today" and "4m ago" stable.
test.use({ timezoneId: "Europe/London" });
const NOW = new Date("2026-10-17T09:00:00Z");

const transform = (page: Page) =>
  page.locator(".agents-world").evaluate((el) => (el as HTMLElement).style.transform);
const zoom = (page: Page) => page.getByLabel("Zoom level");
const builders = (page: Page) => page.locator('.agents-node[data-kind="builder"]');

test.describe("fixed clock", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(NOW);
  });

  test("agents: two projects, a 3-builder cloud run, a sub-agent run, a failed CI and a loose session", async ({
    page,
  }) => {
    await openWindow(page, "agents", "agents");
    await waitForBridgeIdle(page);
    await expect(page.locator('.agents-node[data-kind="project"]')).toHaveCount(2);
    await expect(page.locator('.agents-node[data-kind="orchestrator"]')).toHaveCount(3);
    await expect(builders(page)).toHaveCount(8);
    const jd57 = page.getByRole("button", { name: /^Builder JD-57/ });
    await expect(jd57).toContainText("Failed 1 of 2");
    await expect(jd57).toContainText("#72");
    await expect(page.getByRole("button", { name: /^Builder JD-47/ })).toContainText("sub-agent");
    await expect(page.getByRole("button", { name: "Project JARVIS Desk", exact: true })).toContainText(
      "active",
    );
    // Fitted on load: every card is inside the canvas.
    const canvas = (await page.getByRole("group", { name: "Agent tree" }).boundingBox())!;
    for (const box of await page
      .locator(".agents-node")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON())))
      expect(box.x >= canvas.x - 14 && box.bottom <= canvas.y + canvas.height + 1).toBe(true);
    await expectWindowSnapshot(page, "agents");
  });

  test("agents: drag pans, ⌘-scroll zooms around the pointer, Fit and the zoom buttons", async ({ page }) => {
    await openWindow(page, "agents", "agents");
    await waitForBridgeIdle(page);
    const canvas = page.getByRole("group", { name: "Agent tree" });
    const box = (await canvas.boundingBox())!;
    const fitted = await transform(page);
    const fittedZoom = await zoom(page).textContent();

    // Drag from empty canvas (bottom right) pans and selects nothing.
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 220, box.y + box.height - 120, { steps: 6 });
    await page.mouse.up();
    expect(await transform(page)).not.toBe(fitted);
    await expect(page.getByRole("complementary", { name: "Details" })).toHaveCount(0);

    // A drag that starts on a card pans too, without selecting it.
    const card = (await page.getByRole("button", { name: /^Builder JD-54/ }).boundingBox())!;
    await page.mouse.move(card.x + 40, card.y + 30);
    await page.mouse.down();
    await page.mouse.move(card.x + 140, card.y + 80, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByRole("complementary", { name: "Details" })).toHaveCount(0);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Meta");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Meta");
    await expect(zoom(page)).not.toHaveText(fittedZoom!);

    await page.getByRole("button", { name: "Fit" }).click();
    expect(await transform(page)).toBe(fitted);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoom(page)).not.toHaveText(fittedZoom!);
    await page.getByRole("button", { name: "Zoom out" }).click();
    await expect(zoom(page)).toHaveText(fittedZoom!);
  });

  test("agents: collapse, filters and search by ticket ID", async ({ page }) => {
    await openWindow(page, "agents", "agents");
    await waitForBridgeIdle(page);
    await page.getByRole("button", { name: "Collapse Orchestrator JARVIS batch 13 orchestrator" }).click();
    await expect(builders(page)).toHaveCount(5);
    await page.getByRole("button", { name: "Expand Orchestrator JARVIS batch 13 orchestrator" }).click();
    await expect(builders(page)).toHaveCount(8);

    await page.getByRole("button", { name: "Active only" }).click();
    await expect(page.getByRole("button", { name: /^Builder JD-47/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Builder Try the dashboard/ })).toHaveCount(0);
    await page.getByRole("button", { name: "All", exact: true }).click();

    await page.getByLabel("Project", { exact: true }).selectOption({ label: "Trip planner" });
    await expect(page.getByRole("button", { name: "Project JARVIS Desk", exact: true })).toHaveCount(0);
    await expect(builders(page)).toHaveCount(2);
    await page.getByLabel("Project", { exact: true }).selectOption({ label: "All projects" });

    await page.getByLabel("Search by ticket ID").fill("jd-57");
    await expect(builders(page)).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: "1 match" })).toBeVisible();
  });

  test("agents: a node's details; Open shows claude.ai in the full view and GitHub in the browser", async ({
    page,
  }) => {
    await openWindow(page, "agents", "agents");
    await waitForBridgeIdle(page);
    await page.getByRole("button", { name: /^Builder JD-57/ }).click();
    const panel = page.getByRole("complementary", { name: "Details" });
    await expect(panel.getByRole("heading", { name: /JD-57: Agent graph/ })).toBeVisible();
    await expect(panel.getByText(/expected 3 builders, got 2/)).toBeVisible();
    await expect(panel.getByRole("region", { name: "CI" }).getByRole("listitem")).toHaveCount(2);
    await expect(panel.getByRole("link", { name: /PR #72 on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/MattSharp05/VirtualAssistant/pull/72",
    );
    await panel.getByRole("button", { name: "Session on claude.ai" }).click();
    // The web preview has no web views: the full view's placeholder links to the same page.
    const full = page.getByRole("region", { name: /^Full view/ });
    await expect(full.getByText("Full view works in the app")).toBeVisible();
    await expect(full.getByRole("link")).toHaveAttribute("href", "https://claude.ai/code/session_01JD57");
    await page.getByRole("button", { name: "← Back to the tree" }).click();
    await expect(page.getByRole("group", { name: "Agent tree" })).toBeVisible();
    await panel.getByRole("button", { name: "Ticket JD-57 in Notion" }).click();
    await expect(full.getByRole("link")).toHaveAttribute("href", "https://app.notion.com/p/jd-57");
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });

  test("agents-ci-failed: every check with its state in the panel", async ({ page }) => {
    await openWindow(page, "agents", "agents-ci-failed");
    await waitForBridgeIdle(page);
    await expect(page.getByRole("button", { name: /^Builder JD-57/ })).toContainText("Failed 2 of 4");
    await expect(page.getByRole("button", { name: /^Builder JD-55/ })).toContainText("Failed 1 of 2");
    await page.getByRole("button", { name: /^Builder JD-57/ }).click();
    const checks = page.getByRole("complementary", { name: "Details" }).getByRole("region", { name: "CI" });
    await expect(checks.getByRole("listitem")).toHaveCount(4);
    await expect(checks.locator('li[data-ci="failed"]')).toHaveCount(2);
    await expectWindowSnapshot(page, "agents-ci-failed");
  });

  test("agents-empty: no projects", async ({ page }) => {
    await openWindow(page, "agents", "agents-empty");
    await waitForBridgeIdle(page);
    await expect(page.getByText("No agents yet")).toBeVisible();
    await expectWindowSnapshot(page, "agents-empty");
  });
});

test("agents-live: an agents.changed keeps the pan, zoom and selection, and flashes the card", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  await openWindow(page, "agents", "agents-live");
  const canvas = page.getByRole("group", { name: "Agent tree" });
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 120, box.y + box.height - 60, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: /^Builder JD-55/ }).click();
  const panel = page.getByRole("complementary", { name: "Details" });
  await expect(panel.locator(".agents-ci")).toHaveText(/Running 1\/2/);
  const view = await transform(page);
  const level = await zoom(page).textContent();

  await page.clock.runFor(5_100);
  await expect(panel.locator(".agents-ci")).toHaveText(/Passed 2\/2/);
  await expect(page.locator('[data-node-id="session:session_01JD55"]')).toHaveAttribute("data-flash", "true");
  await expect(panel.getByRole("heading", { name: /JD-55/ })).toBeVisible();
  expect(await transform(page)).toBe(view);
  await expect(zoom(page)).toHaveText(level!);
  await page.clock.runFor(2_000);
  await expect(page.locator('[data-node-id="session:session_01JD55"]')).not.toHaveAttribute("data-flash");
});
