import { expect, test, type Page } from "@playwright/test";
import { expectWindowSnapshot, openWindow, waitForBridgeIdle } from "../helpers";

// A browser task's results (JD-66) in the task sidebar, on the mock bridge: a row with its own page
// opens it in the Browser window; a question typed under a row picks the task back up and the answer
// lands in the sidebar's log; "add it to my to-do list" becomes a JARVIS Task.

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

test("browser-task-results: clicking a result with a page opens it here, with no agent turn", async ({
  page,
}) => {
  await openWindow(page, "browser", "browser-task-results");
  await waitForBridgeIdle(page);
  const results = page.getByRole("region", { name: "Results" });
  await expect(results.getByRole("heading")).toHaveText("Tampa → Johannesburg, one way, Dec 10–12");
  await expect(results.getByRole("listitem")).toHaveCount(4);
  await expectWindowSnapshot(page, "browser-task-results");

  await results.getByRole("button", { name: /Fri Dec 11 · JetBlue/ }).click();
  expect(await commands(page)).toEqual([
    { type: "go", address: "https://flights.example/fare/tpa-jnb-dec11-958" },
  ]);
  await expect(page.getByRole("navigation", { name: "Tabs" })).toContainText("flights.example");
  expect(await posts(page)).toEqual([]);
});

test("browser-task-results-closed: a question under a result jumps back into the sidebar with the answer", async ({
  page,
}) => {
  await openWindow(page, "browser", "browser-task-results-closed");
  await waitForBridgeIdle(page);
  await page.getByRole("button", { name: "Done · show the result" }).click();
  const results = page.getByRole("region", { name: "Results" });
  const ask = results.getByRole("textbox", { name: /Ask about Fri Dec 11 · JetBlue/ });
  await ask.fill("Where are the stops?");
  await ask.press("Enter");
  const sidebar = page.getByRole("region", { name: "Browser task" });
  const log = sidebar.getByRole("list", { name: "Progress" });
  await expect(log).toContainText(
    "Matthew followed up on “Fri Dec 11 · JetBlue + Turkish, 2 stops”: Where are the stops?",
  );
  await expect(log).toContainText("has 2 stops (Toronto, then Istanbul)");
  await expect(sidebar.getByRole("status", { name: "Task state" })).toHaveText("Done");
  expect(await posts(page)).toEqual([
    { path: "/browser/tasks/task-jnb/followup", body: { text: "Where are the stops?", item: 0 } },
  ]);
});

test("browser-task-results: “add it to my to-do list” under a result adds it as a JARVIS Task", async ({
  page,
}) => {
  await openWindow(page, "browser", "browser-task-results");
  await waitForBridgeIdle(page);
  const results = page.getByRole("region", { name: "Results" });
  const row = results.getByRole("listitem").filter({ hasText: "Thu Dec 10" });
  await row.getByRole("textbox").fill("add it to my to-do list");
  await row.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByRole("list", { name: "Progress" })).toContainText(
    "Added “Book: Thu Dec 10 · Air Canada + Emirates, 2 stops, $1,188” to your to-do list.",
  );
  expect(await posts(page)).toEqual([
    { path: "/browser/tasks/task-jnb/followup", body: { text: "add it to my to-do list", item: 1 } },
  ]);
});
