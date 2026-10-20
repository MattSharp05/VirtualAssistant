import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Scenario dates are relative to the preview day; a fixed day keeps labels and snapshots stable.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-20T09:30:00"));
});

const box = (page: Page) => page.getByRole("textbox", { name: "Idea", exact: true });
const group = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Ideas" }).getByRole("region", { name });
const action = (page: Page, id: string) => page.locator(`[data-action="${id}"]`);
const thenButton = (page: Page, label: string) => page.getByRole("button", { name: new RegExp(`^${label}`) });

test("ideas: sidebar by project, Unsorted last; no Notion sync claim; ⌘↵ captures a new idea", async ({
  page,
}) => {
  await openWindow(page, "ideas", "ideas");
  await expect(page.getByRole("heading", { name: "Ideas", level: 1 })).toBeVisible();
  const headings = page.getByRole("navigation", { name: "Ideas" }).getByRole("heading", { level: 2 });
  await expect(headings).toHaveText(["JARVIS Desk3", "Trip planner1", "mk1", "Unsorted2"]);
  await expect(page.getByText(/synced with Notion/)).toHaveCount(0);
  await expect(group(page, "JARVIS Desk").getByText("today · chatted")).toBeVisible();
  await expect(box(page)).toBeFocused();
  await expect(page.getByText("⌘↵ save · saves as you type")).toBeVisible();

  await page.getByLabel("Project").selectOption({ label: "mk" });
  await box(page).fill("Ghost replays of the best lap");
  await box(page).press("ControlOrMeta+Enter");
  await expect(
    group(page, "mk").getByRole("button", { name: /Ghost replays of the best lap/ }),
  ).toBeVisible();
  await expect(page.getByText("saved · edits save as you type")).toBeVisible();
  await expect(page.locator(".ideas-stamp")).toHaveText("today 09:30");

  // Filtering narrows the list.
  await page.getByRole("searchbox", { name: "Filter ideas" }).fill("slack");
  await expect(headings).toHaveText(["Unsorted1"]);
  await waitForBridgeIdle(page);
});

test("ideas: selecting an idea loads it; edits autosave; its history shows under the buttons", async ({
  page,
}) => {
  await openWindow(page, "ideas", "ideas");
  await page.getByRole("button", { name: /^Voice notes straight into Ideas/ }).click();
  await expect(box(page)).toHaveValue(/^Voice notes straight into Ideas\./);
  await expect(page.getByLabel("Project")).toHaveValue("jarvis");
  await expect(page.locator(".ideas-stamp")).toHaveText("today 08:12");
  await expect(page.locator(".ideas-history")).toHaveText("Suggested in To-do 08:14 · Opened in Chat 08:20");
  await expectWindowSnapshot(page, "ideas");

  await box(page).fill("Voice notes into Ideas, tagged by project name");
  await expect(
    group(page, "JARVIS Desk").getByRole("button", { name: /Voice notes into Ideas, tagged/ }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as { __deskMock?: { requests: { path: string; body?: unknown }[] } }
          ).__deskMock!.requests.filter((r) => r.path === "/ideas/voice" && r.body).length,
      ),
    )
    .toBe(1);
});

test("ideas: a pop-up stays open over its button and itself, holds a draft, one at a time", async ({
  page,
}) => {
  await openWindow(page, "ideas", "ideas");
  await page.getByRole("button", { name: /^Orb shows a ring/ }).click();

  // Hover opens it; moving down into the pop-up keeps it open (no gap).
  await thenButton(page, "Chat with JARVIS").hover();
  const chat = page.getByRole("dialog", { name: "Chat with JARVIS" });
  await expect(chat).toBeVisible();
  await expect(chat.getByText("context is optional · ↵ to go")).toBeVisible();
  await chat.getByRole("textbox").hover();
  await expect(chat).toBeVisible();
  // Leaving without text closes it.
  await page.mouse.move(5, 5);
  await expect(chat).toHaveCount(0);

  // With text it stays open after the pointer leaves, and hovering another opens nothing.
  await thenButton(page, "Chat with JARVIS").hover();
  await chat.getByRole("textbox").fill("Is it worth the battery?");
  await expect(chat.getByText("stays open until sent or you click away · ↵ to go")).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(chat).toBeVisible();
  await thenButton(page, "Start a session").hover();
  await expect(page.getByRole("dialog", { name: "Start a session" })).toHaveCount(0);
  await expect(chat).toBeVisible();

  // A click elsewhere keeps the draft (amber dot); clicking the button brings it back.
  await box(page).click();
  await expect(chat).toHaveCount(0);
  await expect(action(page, "chat").getByRole("img", { name: "has a draft" })).toBeVisible();
  await thenButton(page, "Chat with JARVIS").click();
  await expect(chat.getByRole("textbox")).toHaveValue("Is it worth the battery?");

  // Clicking another switches; ✕ discards; Esc closes.
  await thenButton(page, "Add to to-dos").click();
  await expect(page.getByRole("dialog", { name: "Add to to-dos" })).toBeVisible();
  await expect(chat).toHaveCount(0);
  await thenButton(page, "Chat with JARVIS").click();
  await chat.getByRole("button", { name: "Discard draft and close" }).click();
  await expect(chat).toHaveCount(0);
  await expect(action(page, "chat").getByRole("img", { name: "has a draft" })).toHaveCount(0);
  await thenButton(page, "Start a session").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await waitForBridgeIdle(page);
});

test("ideas: Go runs the action, closes the pop-up and adds to the idea's history", async ({ page }) => {
  await openWindow(page, "ideas", "ideas");
  await page.getByRole("button", { name: /^Auto-hold flights/ }).click();
  await thenButton(page, "Add to to-dos").hover();
  await page.getByRole("textbox", { name: "Add to to-dos: extra context" }).fill("before Friday");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".ideas-history")).toHaveText("Suggested in To-do 09:30");
  await expect(group(page, "Trip planner").getByText("today · in To-do suggestions")).toHaveCount(0);
  await expect(group(page, "Trip planner").getByText("Oct 15 · in To-do suggestions")).toBeVisible();

  await thenButton(page, "Start a session").hover();
  await page.getByRole("dialog", { name: "Start a session" }).getByRole("button", { name: "Go" }).click();
  await expect(page.locator(".ideas-history")).toHaveText("Suggested in To-do 09:30 · Session started 09:30");
  await expect(
    page.locator(".ideas-history").getByRole("link", { name: "Session started 09:30" }),
  ).toHaveAttribute("href", /claude\.ai\/code\/session_/);
  // The idea stays in the list.
  await expect(page.getByRole("button", { name: /^Auto-hold flights/ })).toBeVisible();
  await waitForBridgeIdle(page);
});

test("ideas-empty: nothing captured yet", async ({ page }) => {
  await openWindow(page, "ideas", "ideas-empty");
  await expect(page.getByText("No ideas yet. Write one on the right.")).toBeVisible();
  await expect(box(page)).toHaveAttribute("placeholder", "What’s the idea?");
  await expectWindowSnapshot(page, "ideas-empty");
});
