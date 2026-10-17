import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// Browser tasks (JD-60) in the Browser window and beside the orb, on the mock bridge: Normal mode's
// approval, Full autonomy's Pause / Stop, and the password stop's Take over / Hand back.

const posts = (page: Page) =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __deskMock: { requests: { path: string; body?: unknown }[] } }
    ).__deskMock.requests.filter((r) => r.body !== undefined),
  );

const commands = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __deskMock: { browser: { commands: unknown[] } } }).__deskMock.browser
        .commands,
  );

test("browser-task-normal: JARVIS asks before booking; Approve sends the answer and it carries on", async ({
  page,
}) => {
  await openWindow(page, "browser", "browser-task-normal");
  await waitForBridgeIdle(page);
  const strip = page.getByRole("region", { name: "Browser task" });
  await expect(strip).toContainText("Book a table at Taberna da Rua for Friday 8pm for 2");
  await expect(strip.getByText("Normal", { exact: true })).toBeVisible();
  await expect(strip.getByRole("status", { name: "Task state" })).toHaveText("Waiting for you");
  const band = page.getByRole("region", { name: "JARVIS needs your OK" });
  await expect(band).toContainText("Book Taberna da Rua for 2 on Fri 23 Oct at 20:00?");
  await expect(band.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(band.getByRole("button", { name: "Change" })).toBeVisible();
  await expect(band.getByRole("button", { name: "Stop the task" })).toBeVisible();
  await expectWindowSnapshot(page, "browser-task-normal");

  await band.getByRole("button", { name: "Approve" }).click();
  await expect(band).toHaveCount(0);
  await expect(strip.getByRole("status", { name: "Task state" })).toHaveText("Working");
  expect(await posts(page)).toEqual([
    { path: "/browser/tasks/task-taberna/answer", body: { questionId: "q-book", answer: "approve" } },
  ]);
});

test("browser-task-normal: the approval card beside the orb has Approve / Change / Stop", async ({
  page,
}) => {
  await openWindow(page, "overlay", "browser-task-normal");
  await waitForBridgeIdle(page);
  const card = page.getByRole("article", { name: "JARVIS needs your OK" });
  await expect(card).toContainText("Book Taberna da Rua for 2 on Fri 23 Oct at 20:00?");
  await expect(card.getByRole("button")).toHaveText(["Approve", "Change", "Stop"]);
  await card.getByRole("button", { name: "Stop" }).click();
  expect(await posts(page)).toEqual([
    { path: "/browser/tasks/task-taberna/answer", body: { questionId: "q-book", answer: "stop" } },
  ]);
});

test("browser-task-normal: History lists the tasks and a log with its approvals", async ({ page }) => {
  await openWindow(page, "browser", "browser-task-normal");
  await waitForBridgeIdle(page);
  await page.getByRole("button", { name: "History" }).click();
  const history = page.getByRole("region", { name: "Browser task history" });
  await expect(history.getByRole("list", { name: "Tasks" }).getByRole("button")).toHaveCount(4);
  await history.getByRole("button", { name: /Renew the parking permit/ }).click();
  const log = history.getByLabel("Task log");
  await expect(log).toContainText("Matthew approved: OK to click ‘Pay £45’ on permits.example?");
  await expect(log).toContainText("Renewed until 19 Oct 2027");
  await expectWindowSnapshot(page, "browser-task-history");
  await history.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("region", { name: "Page" })).toBeVisible();
});

test("browser-task-full: Full autonomy works on its own; Pause, Resume and Stop", async ({ page }) => {
  await openWindow(page, "browser", "browser-task-full");
  await waitForBridgeIdle(page);
  const strip = page.getByRole("region", { name: "Browser task" });
  await expect(strip.getByText("Full autonomy", { exact: true })).toBeVisible();
  await expect(strip.getByRole("status", { name: "Task state" })).toHaveText("Working");
  await expect(page.getByRole("status", { name: "Status" })).toHaveText("JARVISBooking the table");
  await expect(page.getByRole("region", { name: /JARVIS needs your OK|Over to you/ })).toHaveCount(0);
  await expectWindowSnapshot(page, "browser-task-full");

  await strip.getByRole("button", { name: "Pause" }).click();
  await expect(strip.getByRole("status", { name: "Task state" })).toHaveText("Paused");
  await strip.getByRole("button", { name: "Resume" }).click();
  await expect(strip.getByRole("status", { name: "Task state" })).toHaveText("Working");
  await strip.getByRole("button", { name: "Stop" }).click();
  await expect(strip.getByRole("status", { name: "Task state" })).toHaveText("Stopped");
  expect((await posts(page)).map((r) => r.path)).toEqual([
    "/browser/tasks/task-taberna-full/pause",
    "/browser/tasks/task-taberna-full/resume",
    "/browser/tasks/task-taberna-full/stop",
  ]);
  await page.getByRole("button", { name: "New task" }).click();
  await expect(page.getByRole("form", { name: "New browser task" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Normal" })).toHaveAttribute("aria-checked", "true");
});

test("browser-task-password-stop: Matthew takes over to type the password, then hands back", async ({
  page,
}) => {
  await openWindow(page, "browser", "browser-task-password-stop");
  await waitForBridgeIdle(page);
  const band = page.getByRole("region", { name: "Over to you" });
  await expect(band).toContainText("asks for a password. Take over, type it yourself, then Hand back.");
  await expectWindowSnapshot(page, "browser-task-password-stop");

  await band.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByRole("status", { name: "Status" })).toContainText("You have the browser");
  await band.getByRole("button", { name: "Hand back" }).click();
  await expect(band).toHaveCount(0);
  expect(await commands(page)).toEqual([{ type: "take-over" }, { type: "hand-back" }]);
  expect(await posts(page)).toEqual([{ path: "/browser/tasks/task-taberna-signin/resume", body: {} }]);
  await expect(
    page.getByRole("region", { name: "Browser task" }).getByRole("status", { name: "Task state" }),
  ).toHaveText("Working");
});

test("demo-day: the task box starts a task, Normal unless the request says otherwise", async ({ page }) => {
  await openWindow(page, "browser", "demo-day");
  await waitForBridgeIdle(page);
  const box = page.getByRole("form", { name: "New browser task" });
  await expect(box.getByRole("radio", { name: "Normal" })).toHaveAttribute("aria-checked", "true");
  await expect(box.getByRole("button", { name: "Start" })).toBeDisabled();
  await box.getByLabel("Task").fill("Find the cheapest flight to Lisbon in March");
  await box.getByRole("button", { name: "Start" }).click();
  const strip = page.getByRole("region", { name: "Browser task" });
  await expect(strip).toContainText("Find the cheapest flight to Lisbon in March");
  await expect(strip.getByText("Normal", { exact: true })).toBeVisible();
  await expect(strip.getByRole("status", { name: "Task state" })).toHaveText("Working");
  expect(await posts(page)).toEqual([
    { path: "/browser/tasks", body: { text: "Find the cheapest flight to Lisbon in March", mode: "normal" } },
  ]);
});
