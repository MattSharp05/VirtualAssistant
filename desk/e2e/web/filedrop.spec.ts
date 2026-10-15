import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

const MB = 1024 * 1024;

const mock = <T>(page: Page, key: string) =>
  page.evaluate(
    (k) => (globalThis as unknown as { __deskMock: Record<string, unknown> }).__deskMock[k],
    key,
  ) as Promise<T>;

/** A DataTransfer holding one file of this size, made in the page (what a drag from Finder carries). */
const transfer = (page: Page, name: string, size: number, type = "") =>
  page.evaluateHandle(
    ({ name, size, type }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(size)], name, { type }));
      return dt;
    },
    { name, size, type },
  );

/** Drags a file onto the target and drops it, like the OS does. */
async function dropFile(target: Locator, name: string, size: number, type = "") {
  const dataTransfer = await transfer(target.page(), name, size, type);
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

const orb = (page: Page) => page.getByRole("button", { name: /^JARVIS/ });

test("filedrop: a file dragged over shows the drop ring; dropped on the orb it uploads and asks what to do", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-15T09:00:00Z") });
  await openWindow(page, "overlay", "filedrop");
  // Time stands still from here, so each step of the upload can be looked at.
  await page.clock.pauseAt(new Date("2026-10-15T09:00:05Z"));
  const dataTransfer = await transfer(page, "Q3 report.pdf", 1.4 * MB, "application/pdf");
  await orb(page).dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("Drop for JARVIS")).toBeVisible();
  expect(await mock<boolean>(page, "interactive")).toBe(true);
  await expectWindowSnapshot(page, "filedrop-ring");

  await orb(page).dispatchEvent("drop", { dataTransfer });
  await expect(page.getByText("Drop for JARVIS")).toBeHidden();
  await page.clock.runFor(320);
  const progress = page.getByRole("progressbar", { name: "Uploading Q3 report.pdf" });
  await expect(progress).toHaveAttribute("aria-valuenow", "65");
  await expectWindowSnapshot(page, "filedrop-uploading");

  await page.clock.runFor(200);
  const card = page.getByRole("article", { name: "Dropped file" });
  await expect(card).toContainText("Got Q3 report.pdf. What should I do with it?");
  await expect(card.getByRole("button", { name: "Summarise" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Ask…" })).toBeVisible();
  expect(await mock<{ path: string }[]>(page, "requests")).toContainEqual({
    path: "/files",
    body: { name: "Q3 report.pdf", size: Math.floor(1.4 * MB), type: "application/pdf" },
  });
  await expectWindowSnapshot(page, "filedrop-ready");

  await card.getByRole("button", { name: "Summarise" }).click();
  await expect(card).toBeHidden();
  expect(await mock(page, "chats")).toEqual([
    { text: "Summarise Q3 report.pdf.", channel: "desk-typed", attachments: ["upload-1"] },
  ]);
});

test("filedrop: Ask… opens the command bar with the question started and the file attached", async ({
  page,
}) => {
  await openWindow(page, "overlay", "filedrop");
  await dropFile(orb(page), "screenshot.png", 300_000, "image/png");
  await waitForBridgeIdle(page);
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Ask…" }).click();
  const bar = await popup;
  const input = bar.getByRole("combobox", { name: "Ask JARVIS or open a window" });
  await expect(input).toHaveValue("About screenshot.png: ");
  await expect(bar.locator(".commandbar-file")).toHaveText("screenshot.png");
  await input.pressSequentially("what's wrong here?");
  await input.press("Control+Enter");
  expect(await mock(bar, "chats")).toEqual([
    { text: "About screenshot.png: what's wrong here?", channel: "desk-typed", attachments: ["upload-1"] },
  ]);
});

test("filedrop: a 25 MB file is turned away with a clear message", async ({ page }) => {
  await openWindow(page, "overlay", "filedrop");
  await dropFile(orb(page), "scan.pdf", 25 * MB, "application/pdf");
  await expect(page.getByRole("alert")).toHaveText("scan.pdf is 25 MB: files can be up to 20 MB.");
  expect((await mock<{ path: string }[]>(page, "requests")).filter((r) => r.path === "/files")).toEqual([]);
  await expectWindowSnapshot(page, "filedrop-too-big");
});

test("filedrop: a file dropped on the Chat window goes with the next message", async ({ page }) => {
  await openWindow(page, "chat", "filedrop");
  await waitForBridgeIdle(page);
  const log = page.getByRole("log", { name: "Conversation" });
  const dataTransfer = await transfer(page, "notes.md", 2_000, "text/markdown");
  await log.dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("Drop to attach to your next message")).toBeVisible();
  await log.dispatchEvent("drop", { dataTransfer });
  const chips = page.getByRole("list", { name: "Attached to your next message" });
  await expect(chips).toContainText("notes.md");
  await waitForBridgeIdle(page);
  await expect(chips.getByRole("progressbar")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message JARVIS" }).fill("turn these into to-dos");
  await expectWindowSnapshot(page, "filedrop-chat-chip");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(chips).toBeHidden();
  await expect(page.getByRole("list", { name: "Files sent" })).toHaveText("notes.md");
  expect(await mock(page, "chats")).toEqual([
    { text: "turn these into to-dos", channel: "desk-typed", attachments: ["upload-1"] },
  ]);

  await dropFile(log, "archive.zip", 1_000);
  await expect(page.getByRole("alert")).toContainText("JARVIS can't read .zip files");
});
