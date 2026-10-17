import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// The Browser window (JD-59) on its mock bridge: the page is the preview's stand-in; main draws the
// real one (and the ring in it) in the app.

const commands = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __deskMock: { browser: { commands: unknown[] } } }).__deskMock.browser
        .commands,
  );

test("browser-idle: tabs, address, the task's status line and Take over", async ({ page }) => {
  await openWindow(page, "browser", "browser-idle");
  await waitForBridgeIdle(page);
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(tabs.getByRole("button", { name: /^Book a table · Taberna da Rua/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(tabs.getByRole("button", { name: /^Alfama, Lisbon/ })).toBeVisible();
  await expect(page.getByLabel("Address")).toHaveValue("reservas.example/taberna-da-rua");
  await expect(page.getByRole("status", { name: "Status" })).toHaveText(
    "JARVISBooking a table for 4 · Friday 23 October, 20:00",
  );
  await expect(page.getByRole("button", { name: "Back" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Forward" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Take over" })).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("region", { name: "Page" }).getByRole("heading", { name: "Book a table" }),
  ).toBeVisible();
  await expectWindowSnapshot(page, "browser-idle");
});

test("browser-acting: the ring around “Check availability” for 600 ms, and the caption", async ({ page }) => {
  // A paused clock: the ring's 600 ms and the caption's fade only move when the test says.
  await page.clock.install({ time: new Date("2026-10-17T09:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-17T09:00:01Z"));
  await openWindow(page, "browser", "browser-acting");
  // The scenario's two actions arrive at 100 and 150 ms; 300 ms in, the second one's ring shows.
  await page.clock.runFor(300);
  // (Not waitForBridgeIdle: its polling would wait on the paused clock.)
  expect(
    await page.evaluate(() =>
      (globalThis as unknown as { __deskMock: { pending(): number } }).__deskMock.pending(),
    ),
  ).toBe(0);
  const ring = page.getByTestId("browser-ring");
  await expect(ring).toBeVisible();
  const button = page.getByRole("button", { name: "Check availability" });
  const [r, b] = await Promise.all([ring.boundingBox(), button.boundingBox()]);
  expect(Math.abs(r!.x + 4 - b!.x)).toBeLessThan(1.5);
  expect(Math.abs(r!.y + 4 - b!.y)).toBeLessThan(1.5);
  expect(Math.abs(r!.width - 8 - b!.width)).toBeLessThan(1.5);
  await expect(page.getByText("Clicking ‘Check availability’")).toBeVisible();
  await expect(page.getByText("Typing ‘4’ into ‘Party size’")).toHaveCount(0);
  await expectWindowSnapshot(page, "browser-acting");

  await page.clock.runFor(600);
  await expect(ring).toHaveCount(0);
  await expect(page.getByText("Clicking ‘Check availability’")).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(page.getByText("Clicking ‘Check availability’")).toHaveCount(0);
});

test("browser-takeover: Hand back, JARVIS waiting, and handing back", async ({ page }) => {
  await openWindow(page, "browser", "browser-takeover");
  await waitForBridgeIdle(page);
  const handBack = page.getByRole("button", { name: "Hand back" });
  await expect(handBack).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status", { name: "Status" })).toHaveText(
    "YouYou have the browser. JARVIS waits until you hand it back.",
  );
  await expectWindowSnapshot(page, "browser-takeover");

  await handBack.click();
  await expect(page.getByRole("button", { name: "Take over" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status", { name: "Status" })).toContainText("Booking a table for 4");
  expect(await commands(page)).toEqual([{ type: "hand-back" }]);
});

test("browser: the toolbar is keyboard reachable and the address bar sends Matthew's address", async ({
  page,
}) => {
  await openWindow(page, "browser", "browser-idle");
  await page.getByRole("button", { name: "Back" }).focus();
  await page.keyboard.press("Tab"); // Forward is disabled: Tab skips it
  await expect(page.getByRole("button", { name: "Reload" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Address")).toBeFocused();
  await page.keyboard.type("tables in lisbon friday");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Take over" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hand back" })).toBeVisible();
  expect(await commands(page)).toEqual([
    { type: "go", address: "tables in lisbon friday" },
    { type: "take-over" },
  ]);
});

test("browser: switching to another tab shows its page", async ({ page }) => {
  await openWindow(page, "browser", "browser-idle");
  await page.getByRole("button", { name: /^Alfama, Lisbon/ }).click();
  await expect(
    page.getByRole("region", { name: "Page" }).getByRole("heading", { name: "maps.example" }),
  ).toBeVisible();
  await expect(page.getByLabel("Address")).toHaveValue("maps.example/lisbon/alfama");
});
