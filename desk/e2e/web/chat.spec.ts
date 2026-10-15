import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

const requests = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as { __deskMock?: { requests: { path: string; body?: unknown }[] } }).__deskMock?.requests,
  );

test("chat: history renders with channel tags, steps and metrics, and the calendar change line", async ({
  page,
}) => {
  await openWindow(page, "chat", "chat");
  await waitForBridgeIdle(page);
  await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log.getByText("what did I miss on Slack this morning?")).toBeVisible();
  await expect(log.getByText(/^🎙 voice · \d\d:\d\d$/)).toBeVisible();
  await expect(log.getByText(/^⌨ typed · \d\d:\d\d$/)).toBeVisible();
  await expect(log.getByText(/^Telegram · \d\d:\d\d$/)).toBeVisible();
  await expect(log.getByText("slack search public")).toBeVisible();
  await expect(log.getByText("send to session")).toBeVisible();
  await expect(log.getByText("⏱ 6.4s · 🔢 24k in (20k cached) · 118 out · sonnet · 4 steps")).toBeVisible();
  await expect(page.getByTestId("calendar-change")).toContainText("Moved Booking call to Fri 17 Oct 14:00");
  await expect(page.getByTestId("chat-today")).toHaveText(
    "Today: 14 replies · 182k in · 3.1k out · avg 4.8s",
  );
  await expect(page.getByRole("button", { name: "Push to talk" })).toBeDisabled();
  // Scrolled to the newest message.
  const atBottom = await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2);
  expect(atBottom).toBe(true);
  await expectWindowSnapshot(page, "chat");
});

test("chat: sending shows the message at once and streams the mock reply", async ({ page }) => {
  await openWindow(page, "chat", "chat");
  await waitForBridgeIdle(page);
  const input = page.getByRole("textbox", { name: "Message JARVIS" });
  await input.fill("move the booking call to Friday 2pm");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  const log = page.getByRole("log", { name: "Conversation" });
  await expect(log.getByText("move the booking call to Friday 2pm")).toBeVisible();
  // Mid-stream: the reply bubble is there but not finished yet.
  await expect(page.locator("[data-streaming]")).toHaveCount(1);
  await waitForBridgeIdle(page);
  await expect(page.locator("[data-streaming]")).toHaveCount(0);
  await expect(
    log.getByText("Done. Friday's booking call is at 14:00 and Sam has the new invite."),
  ).toBeVisible();
  await expect(page.getByTestId("chat-today")).toContainText("Today: 15 replies");
});

test("chat: Undo on a calendar change asks JARVIS to undo it", async ({ page }) => {
  await openWindow(page, "chat", "chat");
  await waitForBridgeIdle(page);
  await page.getByRole("button", { name: /^Undo: Moved Booking call/ }).click();
  await expect(page.getByRole("log").getByText("undo that", { exact: true })).toBeVisible();
});

test("chat: the model picker calls the server and New conversation clears the view", async ({ page }) => {
  await openWindow(page, "chat", "chat");
  await waitForBridgeIdle(page);
  const picker = page.getByRole("combobox", { name: "Model" });
  await expect(picker).toHaveValue("claude-sonnet-5-5");
  await picker.selectOption({ label: "haiku" });
  await expect(picker).toHaveValue("claude-haiku-5-5");
  expect(await requests(page)).toContainEqual({ path: "/chat/model", body: { model: "claude-haiku-5-5" } });

  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator(".chat-bubble")).toHaveCount(0);
  await expect(page.getByText("A new conversation.", { exact: false })).toBeVisible();
  expect(await requests(page)).toContainEqual({ path: "/chat/reset", body: {} });
});

test("chat: keyboard reaches the toolbar and the compose bar", async ({ page }) => {
  await openWindow(page, "chat", "chat-empty");
  await waitForBridgeIdle(page);
  const input = page.getByRole("textbox", { name: "Message JARVIS" });
  await input.focus();
  await input.fill("hello");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Send" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log").getByText("hello", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Model" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "New conversation" })).toBeFocused();
});

test("chat-empty: a fresh conversation", async ({ page }) => {
  await openWindow(page, "chat", "chat-empty");
  await waitForBridgeIdle(page);
  await expect(page.getByText("A new conversation.", { exact: false })).toBeVisible();
  await expectWindowSnapshot(page, "chat-empty");
});

test("chat-streaming: a Telegram turn streams in with a step still running", async ({ page }) => {
  // Live messages are stamped with the clock: keep it still for the snapshot.
  await page.clock.setFixedTime(new Date("2026-10-14T09:15:00Z"));
  await openWindow(page, "chat", "chat-streaming");
  await waitForBridgeIdle(page);
  const streaming = page.locator("[data-streaming]");
  await expect(streaming).toContainText("Yes. It's on Friday at");
  await expect(streaming.locator(".chat-step-running")).toHaveText("list events");
  await expect(page.getByRole("log").getByText("is the booking call sorted?")).toBeVisible();
  await expectWindowSnapshot(page, "chat-streaming");
});
