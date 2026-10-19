import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Signing in to a full view (JD-68), on the mock bridge's full views (as in the app, minus the site):
// the hint bar's "Sign in with a link" takes a link pasted from the email.
test.use({ timezoneId: "Europe/London" });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-14T09:00:00Z"));
});

async function openFullView(page: Page, scenario: string) {
  await openWindow(page, "sessions", scenario);
  await expect(page.getByRole("heading", { level: 2, name: "mk" })).toBeVisible();
  await page.getByRole("tab", { name: "Full view (claude.ai)" }).click();
  await expect(page.getByRole("region", { name: "mk on claude.ai" })).toBeVisible();
  await waitForBridgeIdle(page);
}

const links = (page: Page) =>
  page.evaluate(
    () => (globalThis as { __deskMock?: { webview?: { links: string[] } } }).__deskMock?.webview?.links ?? [],
  );

test("the hint shows Sign in with a link and opens a pasted link", async ({ page }) => {
  await openFullView(page, "fullview-signin");
  const hint = page.getByRole("note", { name: "Signing in" });
  await expect(hint).toContainText("don't click it, it opens your browser");
  await expectWindowSnapshot(page, "fullview-signin");

  await hint.getByRole("button", { name: "Sign in with a link" }).click();
  const input = page.getByRole("textbox", { name: "Sign-in link from the email" });
  await expect(input).toBeFocused();

  // Not a claude.ai or Notion link: refused, with the reason.
  await input.fill("https://evil.example/magic-link#abc");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Paste the whole link from the email");
  await expectWindowSnapshot(page, "fullview-signin-link-error");

  await input.fill("https://claude.ai/magic-link#abc123:bWF0dGhld0BleGFtcGxlLmNvbQ==");
  await page.getByRole("button", { name: "Open link" }).click();
  await expect(input).toHaveCount(0);
  expect(await links(page)).toEqual(["https://claude.ai/magic-link#abc123:bWF0dGhld0BleGFtcGxlLmNvbQ=="]);
});

test("Google refusing the embedded sign-in points to the email link", async ({ page }) => {
  await openFullView(page, "fullview-google-blocked");
  await expect(page.getByRole("note", { name: "Signing in" })).toContainText(
    "Google won't sign in inside the app: use email sign-in instead.",
  );
  await expectWindowSnapshot(page, "fullview-google-blocked");
});

test("Sign in with a link is keyboard reachable", async ({ page }) => {
  await openFullView(page, "fullview-signin");
  const action = page.getByRole("button", { name: "Sign in with a link" });
  await action.focus();
  await page.keyboard.press("Enter");
  const input = page.getByRole("textbox", { name: "Sign-in link from the email" });
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});

test("Settings → Connection: Sign out of web views", async ({ page }) => {
  await openWindow(page, "settings", "settings");
  await page.getByRole("button", { name: "Sign out of web views" }).click();
  await expect(page.getByRole("status", { name: "Sign-out result" })).toHaveText(
    "Signed out of claude.ai and Notion.",
  );
  const signOuts = await page.evaluate(
    () => (globalThis as { __deskMock?: { mac: { webSignOuts: number } } }).__deskMock?.mac.webSignOuts,
  );
  expect(signOuts).toBe(1);
});
