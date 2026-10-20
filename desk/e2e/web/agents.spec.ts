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

    // A jump chip moves the view; it filters nothing away.
    await page.getByRole("button", { name: /^Jump to Trip planner/ }).click();
    await expect(page.getByRole("button", { name: "Project JARVIS Desk", exact: true })).toHaveCount(1);
    await expect(builders(page)).toHaveCount(8);

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

  test("agents-projects: four bands, jump chips bring a band into view, the label stays pinned left", async ({
    page,
  }) => {
    await openWindow(page, "agents", "agents-projects");
    await waitForBridgeIdle(page);
    await expect(page.locator(".agents-band")).toHaveCount(4);
    const canvas = (await page.getByRole("group", { name: "Agent tree" }).boundingBox())!;
    const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
    // Each label fills its band, and every card of a project sits inside its band.
    for (const id of ["project:jarvis", "project:trip", "project:mk", "project:gogentic"]) {
      const band = await box(`.agents-band[data-band="${id}"]`);
      const label = await box(`[data-node-id="${id}"]`);
      expect(Math.abs(label.y - band.y)).toBeLessThan(2);
      expect(Math.abs(label.height - band.height)).toBeLessThan(2);
    }
    const mkBand = await box('.agents-band[data-band="project:mk"]');
    for (const id of ["session:session_01MKorch", "session:session_01MK81", "session:session_01MK79"]) {
      const b = await box(`[data-node-id="${id}"]`);
      expect(b.y >= mkBand.y && b.y + b.height <= mkBand.y + mkBand.height, id).toBe(true);
    }

    // Zoom in, then jump: that project's band comes into view.
    for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: /^Jump to mk/ }).click();
    const band = await box('.agents-band[data-band="project:mk"]');
    expect(band.y).toBeGreaterThanOrEqual(canvas.y - 1);
    expect(band.y + band.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
    await page.getByRole("button", { name: /^Jump to JARVIS Desk/ }).click();

    // Pan right (wheel): the world moves left but the label stays at the canvas's left edge.
    const label = page.locator('[data-node-id="project:jarvis"]');
    const orch = page.locator('[data-node-id="session:session_01JDorch13"]');
    const orchBefore = (await orch.boundingBox())!.x;
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.wheel(500, 0);
    await expect.poll(async () => (await orch.boundingBox())!.x).toBeLessThan(orchBefore - 100);
    expect(Math.abs((await label.boundingBox())!.x - canvas.x)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Project JARVIS Desk", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Details" })).toBeVisible();
  });

  test("agents-projects: the minimap shows every band and the viewport; clicking it moves the view", async ({
    page,
  }) => {
    await openWindow(page, "agents", "agents-projects");
    await waitForBridgeIdle(page);
    const map = page.getByRole("group", { name: "Overview map" });
    await expect(map).toBeVisible();
    await expect(map.locator(".agents-minimap-band")).toHaveCount(4);
    await expect(map.locator('[data-band="project:mk"]')).toHaveAttribute("data-tone", "waiting");
    await expect(map.locator('[data-band="project:gogentic"]')).toHaveAttribute("data-tone", "quiet");
    const viewport = page.getByTestId("minimap-viewport");
    await expect(viewport).toBeVisible();

    for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "Zoom in" }).click();
    const before = await transform(page);
    const vpBefore = (await viewport.boundingBox())!;
    // Click the bottom bar (Gogentic site): the view moves down to it.
    const bar = (await map.locator('[data-band="project:gogentic"]').boundingBox())!;
    await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
    expect(await transform(page)).not.toBe(before);
    expect((await viewport.boundingBox())!.y).toBeGreaterThan(vpBefore.y);
    await expect(page.locator('[data-node-id="project:gogentic"]')).toBeInViewport();
    // Clicking the map selects nothing on the canvas.
    await expect(page.getByRole("complementary", { name: "Details" })).toHaveCount(0);

    // Dragging in the map moves the view with it.
    const area = (await map.locator(".agents-minimap-area").boundingBox())!;
    await page.mouse.move(area.x + 10, area.y + 10);
    await page.mouse.down();
    const mid = await transform(page);
    await page.mouse.move(area.x + area.width - 10, area.y + 20, { steps: 5 });
    await page.mouse.up();
    expect(await transform(page)).not.toBe(mid);
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
