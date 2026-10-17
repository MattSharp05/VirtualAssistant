import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Records openWindow calls (instead of opening preview tabs) and the questions sent to JARVIS.
async function record(page: Page) {
  await page.evaluate(() => {
    const g = globalThis as {
      __deskMock?: {
        openWindow(id: string, params?: Record<string, string>): void;
        subscribe(fn: (e: { type: string; text?: string; channel?: string }) => void): () => void;
      };
      __opened?: [string, Record<string, string> | undefined][];
      __chats?: { text?: string; channel?: string }[];
    };
    g.__opened = [];
    g.__chats = [];
    g.__deskMock!.openWindow = (id, params) => void g.__opened!.push([id, params]);
    g.__deskMock!.subscribe(
      (e) => e.type === "brain.start" && g.__chats!.push({ text: e.text, channel: e.channel }),
    );
  });
}
const mock = <T>(page: Page, key: "__opened" | "__chats" | "frameActions") =>
  page.evaluate(
    (k) =>
      (k === "frameActions"
        ? (globalThis as { __deskMock?: { frameActions: string[] } }).__deskMock?.frameActions
        : (globalThis as Record<string, unknown>)[k]) as T,
    key,
  );

test.beforeEach(async ({ page }) => {
  await openWindow(page, "commandbar", "commandbar");
  await waitForBridgeIdle(page);
  await record(page);
});

test("commandbar: “mk” lists the session first; ↵ opens it in Sessions", async ({ page }) => {
  const input = page.getByRole("combobox", { name: "Ask JARVIS or open a window" });
  await expect(input).toBeFocused();
  await expectWindowSnapshot(page, "commandbar");
  await input.fill("mk");
  const options = page.getByRole("option");
  await expect(options.first()).toHaveAccessibleName("Open session mk (Mario Kart orchestrator)");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option", { name: "Notion: Mario Kart PRD" })).toBeVisible();
  await expect(options.last()).toHaveAccessibleName("Ask JARVIS: “mk”");
  await expectWindowSnapshot(page, "commandbar-mk");

  await page.keyboard.press("Enter");
  expect(await mock(page, "__opened")).toEqual([["sessions", { id: "mk" }]]);
  expect(await mock(page, "frameActions")).toEqual(["close"]);
});

test("commandbar: ⌘↵ asks JARVIS what was typed", async ({ page }) => {
  await page.getByRole("combobox", { name: "Ask JARVIS or open a window" }).fill("mk");
  await expect(page.getByRole("option").first()).toHaveAccessibleName(/^Open session mk/);
  await page.keyboard.press("Meta+Enter");
  await expect.poll(() => mock(page, "__chats")).toEqual([{ text: "mk", channel: "desk-typed" }]);
  await expect.poll(() => mock(page, "frameActions")).toEqual(["close"]);
  expect(await mock(page, "__opened")).toEqual([]);
});

test("commandbar: ↑↓ move the highlight, Esc closes, rows are buttons", async ({ page }) => {
  const input = page.getByRole("combobox", { name: "Ask JARVIS or open a window" });
  await input.fill("mk");
  await expect(page.getByRole("option", { name: "Notion: Mario Kart PRD" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { selected: true })).toHaveAccessibleName("Notion: Mario Kart PRD");
  await page.keyboard.press("Enter");
  expect(await mock(page, "__opened")).toEqual([["notion", { page: "page-mk-prd" }]]);

  await input.fill("work");
  await page.getByRole("option", { name: "Layout: Work mode" }).click();
  expect((await mock<[string][]>(page, "__opened")).slice(1).map(([id]) => id)).toEqual([
    "chat",
    "sessions",
    "today",
  ]);

  await input.focus();
  await page.keyboard.press("Escape");
  expect(await mock(page, "frameActions")).toEqual(["close", "close", "close"]);
});

test("commandbar: “quit” offers Quit JARVIS Desk; ↵ quits through the bridge (JD-62)", async ({ page }) => {
  const input = page.getByRole("combobox", { name: "Ask JARVIS or open a window" });
  await input.fill("quit");
  const first = page.getByRole("option").first();
  await expect(first).toHaveAccessibleName("Quit JARVIS Desk");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expectWindowSnapshot(page, "commandbar-quit");
  await page.keyboard.press("Enter");
  const appActions = () =>
    page.evaluate(() => (globalThis as { __deskMock?: { appActions: string[] } }).__deskMock?.appActions);
  expect(await appActions()).toEqual(["quit"]);
  expect(await mock(page, "__opened")).toEqual([]);
});
